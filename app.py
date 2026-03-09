import sys
import streamlit as st
import requests
import time
import base64
import threading
import telebot
from telebot import types
from datetime import datetime
import pandas as pd
import io

# --- СЕКРЕТЫ ---
MODUL_TOKEN = st.secrets.get("MODUL_TOKEN", "")
CP_ID = st.secrets.get("CP_ID", "")
CP_SECRET = st.secrets.get("CP_SECRET", "")
MY_INN = st.secrets.get("MY_INN", "")
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 
SHEET_URL = st.secrets.get("SHEET_URL", "") 

# --- ГЛОБАЛЬНАЯ БАЗА ДАННЫХ И БОТ ---
@st.cache_resource
def init_bot():
    return telebot.TeleBot(TG_TOKEN)

bot = init_bot()

@st.cache_resource
def get_state():
    return {
        "active_orders": {}, 
        "users": {},
        "company_id": None,
        "retail_point_id": None,
        "logs": [],
        "bot_running": False 
    }

state = get_state()

def add_log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    state["logs"].append(f"[{now}] {msg}")
    if len(state["logs"]) > 50: state["logs"].pop(0)

# --- ИНТЕГРАЦИЯ С БАНКОМ ---
def get_retail_id():
    headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
    try:
        if not state["company_id"]:
            r_acc = requests.post("https://api.modulbank.ru/v1/account-info", headers=headers)
            state["company_id"] = r_acc.json()[0].get("companyId") or r_acc.json()[0].get("id")
        
        url = f"https://api.modulbank.ru/v1/sbp/retail-points?companyId={state['company_id']}"
        points = requests.get(url, headers=headers).json()
        return points[0].get("id")
    except: return None

def create_payment(amount, description):
    if not state["retail_point_id"]: state["retail_point_id"] = get_retail_id()
    if not state["retail_point_id"]: return None, None

    url = "https://api.modulbank.ru/v1/sbp/qr-codes/dynamic"
    payload = {
        "retailPointId": state["retail_point_id"],
        "sum": float(amount),
        "extraInfo": description[:140],
        "lifetime": 15 
    }
    try:
        r = requests.post(url, json=payload, headers={"Authorization": f"Bearer {MODUL_TOKEN}"})
        return r.json().get("payload"), r.json().get("qrcId")
    except: return None, None

def send_receipt(amount, email, item_name):
    auth = base64.b64encode(f"{CP_ID}:{CP_SECRET}".encode()).decode()
    payload = {
        "Inn": MY_INN, "Type": "Income",
        "CustomerReceipt": {
            "Items": [{"label": item_name, "price": amount, "quantity": 1, "amount": amount, "vat": None, "method": 1, "object": 1}],
            "taxationSystem": 1, "email": email
        }
    }
    try:
        res = requests.post("https://api.cloudpayments.ru/kkt/receipt", json=payload, headers={"Authorization": f"Basic {auth}"})
        return res.status_code == 200
    except: return False

# --- КЭШИРОВАНИЕ ТАБЛИЦЫ ---
@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        r = requests.get(export_url, headers=headers, timeout=45)
        if r.status_code != 200: return None
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except: return None

# --- НОВЫЙ ЛИНГВИСТИЧЕСКИЙ ПОИСК ---
def get_items_from_sheet(username, target_status):
    if not SHEET_URL:
        return "⚠️ Ошибка: ссылка на таблицу не настроена в админке."
    try:
        all_sheets = fetch_cached_sheet(SHEET_URL)
        if all_sheets is None:
            return "⚠️ Не удалось получить данные. Нажмите «Сбросить кэш» в админке."
        
        # Словарь для группировки: { "10": ["6", "10"], "23": ["твайлайт"] }
        found_data = {}
        
        for sheet_name, df in all_sheets.items():
            if df.empty: continue
            
            # Ищем колонки
            status_col = next((c for c in df.columns if 'статус' in str(c).lower()), None)
            item_col = next((c for c in df.columns if 'позиции' in str(c).lower()), None)
            razbor_col = next((c for c in df.columns if 'разбор' in str(c).lower()), None)
            
            if not status_col or not item_col: continue 
                
            # Фильтруем по статусу
            df_status = df[df[status_col].astype(str).str.lower().str.strip() == target_status.lower()]
            if df_status.empty: continue
            
            for _, row in df_status.iterrows():
                # Проверяем, есть ли в этой строке упоминание юзера (чтобы не брать чужие разборы)
                row_str = " ".join(row.astype(str).lower())
                if username.lower().replace('@', '') not in row_str:
                    continue

                cell_text = str(row[item_col])
                razbor_num = str(row[razbor_col]).replace('.0', '') if razbor_col and pd.notna(row[razbor_col]) else "???"
                
                # Парсим строки внутри ячейки
                lines = cell_text.split('\n')
                user_items = []
                for line in lines:
                    line = line.strip()
                    if not line: continue
                    
                    if '-' in line:
                        parts = line.split('-', 1)
                        label = parts[0].strip()
                        handle = parts[1].strip()
                        # Если после тире ПУСТО — это наше!
                        if not handle:
                            user_items.append(label)
                    else:
                        # Если ТИРЕ НЕТ вообще — скорее всего это тоже наша позиция (как в твоем примере)
                        user_items.append(line)
                
                if user_items:
                    if razbor_num not in found_data:
                        found_data[razbor_num] = []
                    found_data[razbor_num].extend(user_items)

        if not found_data:
            return None
            
        # Формируем красивый ответ
        reply = f"🔍 Ваши позиции со статусом <b>«{target_status}»</b>:\n\n"
        for r_num, items in found_data.items():
            # Убираем дубликаты и склеиваем через запятую
            items_str = ", ".join(dict.fromkeys(items))
            reply += f"• <b>Разбор № {r_num}</b> — {items_str}\n"
            
        return reply
    except Exception as e:
        add_log(f"Ошибка поиска: {e}")
        return "⚠️ Ошибка при чтении данных таблицы."

# --- ОБРАБОТЧИКИ ТЕЛЕГРАМ ---
bot.message_handlers = []
bot.callback_query_handlers = []

@bot.message_handler(commands=['start'])
def welcome_and_auth(message):
    msg = bot.send_message(message.chat.id, "👋 Добро пожаловать!\n\nВведите ваш логин (юзернейм) в нашей системе:")
    bot.register_next_step_handler(msg, send_welcome_menu)

def send_welcome_menu(message):
    username = message.text
    state["users"][message.chat.id] = username 
    welcome_text = (
        f"🎉 Авторизация успешна!\n\n"
        f"Добро пожаловать в <b>hellopinky</b>🌸✨\n\n"
        f"Менеджеры: @hellopinky_manager, @melamories\n\n"
        f"Что будем делать, <b>{username}</b>?"
    )
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
               types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.send_message(message.chat.id, welcome_text, reply_markup=markup, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_buttons(call):
    bot.answer_callback_query(call.id) 
    chat_id = call.message.chat.id
    username = state["users"].get(chat_id)
    
    if not username:
        bot.send_message(chat_id, "⚠️ Сессия истекла. Нажмите /start")
        return
    
    if call.data == "pay":
        msg = bot.send_message(chat_id, "🛍️ Что оплачиваем? (Название товара)")
        bot.register_next_step_handler(msg, ask_amount)
    elif call.data == "track":
        markup = types.InlineKeyboardMarkup(row_width=1)
        markup.add(types.InlineKeyboardButton("🛒 Выкуплен", callback_data="status_выкуплен"),
                   types.InlineKeyboardButton("🇨🇳 На кит адресе", callback_data="status_на кит адресе"),
                   types.InlineKeyboardButton("🚚 Едет в РФ", callback_data="status_едет в рф"),
                   types.InlineKeyboardButton("🇷🇺 В РФ", callback_data="status_в рф"),
                   types.InlineKeyboardButton("🔙 Назад", callback_data="back_to_main"))
        bot.edit_message_text(chat_id=chat_id, message_id=call.message.message_id, 
                              text=f"🔍 Выберите статус:", reply_markup=markup, parse_mode="HTML")
    elif call.data.startswith("status_"):
        target_status = call.data.split("_")[1]
        bot.send_message(chat_id, f"🔄 Ищу ваши позиции «{target_status}»...")
        res = get_items_from_sheet(username, target_status)
        bot.send_message(chat_id, res if res else f"Позиций со статусом «{target_status}» для вас не найдено. 🥺", parse_mode="HTML")
    elif call.data == "back_to_main":
        welcome_menu_back(call.message, username)

def welcome_menu_back(message, username):
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
               types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.edit_message_text(chat_id=message.chat.id, message_id=message.message_id, 
                          text=f"Что будем делать, <b>{username}</b>?", reply_markup=markup, parse_mode="HTML")

def ask_amount(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"Сумма за '{item}' (только цифры):")
    bot.register_next_step_handler(msg, ask_email, item)

def ask_email(message, item):
    try:
        amt = float(message.text)
        msg = bot.send_message(message.chat.id, "Ваш E-mail для чека:")
        bot.register_next_step_handler(msg, generate_bill, item, amt)
    except: bot.send_message(message.chat.id, "❌ Ошибка. Начните заново: /start")

def generate_bill(message, item, amt):
    email = message.text
    username = state["users"].get(message.chat.id, "Гость")
    if "@" not in email:
        bot.send_message(message.chat.id, "❌ Неверный email. /start")
        return
    bot.send_message(message.chat.id, "🔄 Генерирую счет...")
    link, qid = create_payment(amt, item)
    if link and qid:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "username": username, "item": item, "amt": amt, "email": email, "created_at": time.time()}
        markup = types.InlineKeyboardMarkup()
        markup.add(types.InlineKeyboardButton(text=f"💳 Оплатить {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет готов!</b>\n📦 {item}\n💰 {amt} ₽", reply_markup=markup, parse_mode="HTML")
    else: bot.send_message(message.chat.id, "❌ Ошибка банка.")

# --- ЗАПУСК ---
@st.cache_resource
def start_background_tasks():
    if state["bot_running"]: return True
    state["bot_running"] = True
    try: bot.remove_webhook()
    except: pass
    def checker_loop():
        headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
        while True:
            try:
                now_ts = time.time()
                for qid, order in list(state["active_orders"].items()):
                    if now_ts - order["created_at"] > 900:
                        bot.send_message(order["chat_id"], f"⏳ Время на оплату '{order['item']}' вышло.")
                        del state["active_orders"][qid]
                    else:
                        r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers=headers)
                        if r.status_code == 200 and r.json().get("status") == "Accepted":
                            bot.send_message(order["chat_id"], f"🎉 Оплата получена!")
                            send_receipt(r.json().get("amount", order["amt"]), order["email"], order["item"])
                            del state["active_orders"][qid]
            except: pass
            time.sleep(10)
    def tg_polling():
        while True:
            try: bot.polling(none_stop=True, interval=2, timeout=20)
            except telebot.apihelper.ApiTelegramException as e:
                if e.error_code == 409: time.sleep(15)
                else: time.sleep(5)
            except: time.sleep(5)
    threading.Thread(target=checker_loop, daemon=True).start()
    threading.Thread(target=tg_polling, daemon=True).start()
    return True

start_background_tasks()

# --- АДМИНКА ---
st.set_page_config(page_title="Админка hellopinky", layout="centered")
st.title("🤖 Панель hellopinky")
c1, c2 = st.columns(2)
with c1:
    st.write("### ⏳ Ждут оплаты:")
    for qid, o in state["active_orders"].items():
        st.warning(f"👤 {o['username']}\n📦 {o['item']}")
with c2:
    st.write("### 📜 Логи:")
    st.code("\n".join(reversed(state["logs"])))
    if st.button("🗑 Сбросить кэш таблицы"):
        fetch_cached_sheet.clear()
        add_log("Кэш очищен")
if st.button("🔄 Обновить панель"): st.rerun()
