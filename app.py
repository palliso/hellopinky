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

# --- 1. КОНФИГУРАЦИЯ И СЕКРЕТЫ ---
MODUL_TOKEN = st.secrets.get("MODUL_TOKEN", "")
CP_ID = st.secrets.get("CP_ID", "")
CP_SECRET = st.secrets.get("CP_SECRET", "")
MY_INN = st.secrets.get("MY_INN", "")
# Ссылка на Google Таблицу (должна быть в Secrets Streamlit)
SHEET_URL = st.secrets.get("SHEET_URL", "") 
# Токен бота hellopinky
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 

# --- 2. ИНИЦИАЛИЗАЦИЯ СОСТОЯНИЯ ---
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

# --- 3. РАБОТА С GOOGLE ТАБЛИЦЕЙ (КЭШ И ПОИСК) ---



@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        # Превращаем ссылку в формат для скачивания Excel
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'}
        r = requests.get(export_url, headers=headers, timeout=45)
        if r.status_code != 200: return None
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except Exception as e:
        add_log(f"Ошибка загрузки таблицы: {e}")
        return None

def get_items_from_sheet(username, target_status):
    if not SHEET_URL:
        return "⚠️ Ошибка: ссылка на таблицу не настроена в админке."
    try:
        all_sheets = fetch_cached_sheet(SHEET_URL)
        if all_sheets is None:
            return "⚠️ Не удалось получить данные. Нажмите «Сбросить кэш» в админке."
        
        found_data = {}
        u_clean = username.lower().replace('@', '').strip()

        for sheet_name, df in all_sheets.items():
            if df.empty: continue
            
            # Ищем колонки (гибкие названия)
            status_col = next((c for c in df.columns if any(w in str(c).lower() for w in ['статус', 'что ждём', 'status'])), None)
            item_col = next((c for c in df.columns if any(w in str(c).lower() for w in ['позиции', 'коллективка', 'товар'])), None)
            razbor_col = next((c for c in df.columns if any(w in str(c).lower() for w in ['разбор', 'заказа', '№'])), None)
            
            if not status_col or not item_col: continue 

            # Фильтруем по статусу (ищем вхождение слова, например "в рф")
            mask_status = df[status_col].astype(str).str.lower().str.contains(target_status.lower().strip())
            df_filtered = df[mask_status]
            
            for _, row in df_filtered.iterrows():
                # Определяем номер разбора/заказа
                r_id = str(row[razbor_col]).replace('.0', '').strip() if razbor_col and pd.notna(row[razbor_col]) else "???"
                cell_text = str(row[item_col])
                
                # Парсим содержимое ячейки
                parts = cell_text.replace('\n', ',').replace(';', ',').split(',')
                user_items = []
                
                for part in parts:
                    part = part.strip()
                    if not part: continue
                    
                    if '-' in part:
                        label, owner = part.split('-', 1)
                        owner_info = owner.lower().replace('@', '').strip()
                        # ЛОГИКА: если в части после тире есть ник клиента
                        if u_clean in owner_info and owner_info != "":
                            user_items.append(label.strip())
                    elif u_clean in part.lower():
                        # Если тире нет, но ник упомянут
                        clean_p = part.lower().replace(u_clean, "").replace('@', '').strip()
                        if clean_p: user_items.append(clean_p.capitalize())

                if user_items:
                    if r_id not in found_data: found_data[r_id] = []
                    for i in user_items:
                        if i not in found_data[r_id]: found_data[r_id].append(i)

        if not found_data: return None
            
        reply = f"🔍 Ваши позиции со статусом <b>«{target_status}»</b>:\n\n"
        # Сортировка по номерам разборов
        try:
            sorted_keys = sorted(found_data.keys(), key=lambda x: int(''.join(filter(str.isdigit, str(x))) or 0))
        except:
            sorted_keys = sorted(found_data.keys())

        for r_num in sorted_keys:
            items_str = ", ".join(found_data[r_num])
            reply += f"• <b>разбор № {r_num}</b> — {items_str}\n"
        return reply
    except Exception as e:
        add_log(f"Ошибка поиска: {e}")
        return "⚠️ Ошибка при обработке таблицы."

# --- 4. БАНКОВСКИЕ ФУНКЦИИ ---
def get_retail_id():
    headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
    try:
        if not state["company_id"]:
            r_acc = requests.post("https://api.modulbank.ru/v1/account-info", headers=headers)
            state["company_id"] = r_acc.json()[0].get("companyId") or r_acc.json()[0].get("id")
        points = requests.get(f"https://api.modulbank.ru/v1/sbp/retail-points?companyId={state['company_id']}", headers=headers).json()
        return points[0].get("id")
    except: return None

def create_payment(amount, description):
    rid = get_retail_id()
    if not rid: return None, None
    url = "https://api.modulbank.ru/v1/sbp/qr-codes/dynamic"
    payload = {"retailPointId": rid, "sum": float(amount), "extraInfo": description[:140], "lifetime": 15}
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
    try: requests.post("https://api.cloudpayments.ru/kkt/receipt", json=payload, headers={"Authorization": f"Basic {auth}"})
    except: pass

# --- 5. ОБРАБОТЧИКИ ТЕЛЕГРАМ ---
bot.message_handlers = []
bot.callback_query_handlers = []

@bot.message_handler(commands=['start'])
def welcome(message):
    msg = bot.send_message(message.chat.id, "👋 Привет! Введите ваш логин (юзернейм) в системе:")
    bot.register_next_step_handler(msg, auth_user)

def auth_user(message):
    username = message.text
    state["users"][message.chat.id] = username
    markup = types.InlineKeyboardMarkup()
    markup.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
               types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.send_message(message.chat.id, f"🎉 Доступ разрешен, <b>{username}</b>!", reply_markup=markup, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_query(call):
    bot.answer_callback_query(call.id)
    chat_id = call.message.chat.id
    username = state["users"].get(chat_id)
    if not username:
        bot.send_message(chat_id, "⚠️ Сессия истекла. Нажмите /start")
        return

    if call.data == "pay":
        msg = bot.send_message(chat_id, "🛍️ Что оплачиваем?")
        bot.register_next_step_handler(msg, ask_amount)
    elif call.data == "track":
        markup = types.InlineKeyboardMarkup(row_width=1)
        for s in ["выкуплен", "на кит адресе", "едет в рф", "в рф"]:
            markup.add(types.InlineKeyboardButton(s.capitalize(), callback_data=f"st_{s}"))
        markup.add(types.InlineKeyboardButton("🔙 Назад", callback_data="back"))
        bot.edit_message_text(chat_id=chat_id, message_id=call.message.message_id, text="🔍 Выберите статус:", reply_markup=markup)
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        bot.send_message(chat_id, f"🔄 Ищу позиции «{status}»...")
        res = get_items_from_sheet(username, status)
        bot.send_message(chat_id, res if res else f"Позиций со статусом «{status}» не найдено. 🥺", parse_mode="HTML")
    elif call.data == "back":
        auth_user(call.message)

def ask_amount(message):
    bot.send_message(message.chat.id, f"Сумма за '{message.text}' (цифрами):")
    bot.register_next_step_handler(message, ask_email, message.text)

def ask_email(message, item):
    try:
        amt = float(message.text)
        bot.send_message(message.chat.id, "Ваш E-mail для чека:")
        bot.register_next_step_handler(message, process_pay, item, amt)
    except: bot.send_message(message.chat.id, "❌ Ошибка. /start")

def process_pay(message, item, amt):
    email = message.text
    if "@" not in email:
        bot.send_message(message.chat.id, "❌ Email неверный. /start")
        return
    bot.send_message(message.chat.id, "🔄 Генерирую счет...")
    link, qid = create_payment(amt, item)
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "username": state["users"][message.chat.id], "item": item, "amt": amt, "email": email, "created_at": time.time()}
        markup = types.InlineKeyboardMarkup()
        markup.add(types.InlineKeyboardButton(text=f"💳 Оплатить {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет готов!</b>\n📦 {item}\n💰 {amt} ₽", reply_markup=markup, parse_mode="HTML")
    else: bot.send_message(message.chat.id, "❌ Ошибка банка.")

# --- 6. ЗАПУСК ПОТОКОВ ---
@st.cache_resource
def start_tasks():
    if state["bot_running"]: return
    state["bot_running"] = True
    def checker():
        headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
        while True:
            for qid, o in list(state["active_orders"].items()):
                if time.time() - o["created_at"] > 900: del state["active_orders"][qid]
                else:
                    r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers=headers)
                    if r.status_code == 200 and r.json().get("status") == "Accepted":
                        bot.send_message(o["chat_id"], "🎉 Оплата получена!")
                        send_receipt(o["amt"], o["email"], o["item"])
                        del state["active_orders"][qid]
            time.sleep(10)
    def poller():
        while True:
            try: bot.polling(none_stop=True, interval=2, timeout=20)
            except telebot.apihelper.ApiTelegramException as e:
                if e.error_code == 409: time.sleep(15)
                else: time.sleep(5)
            except: time.sleep(5)
    threading.Thread(target=checker, daemon=True).start()
    threading.Thread(target=poller, daemon=True).start()

start_tasks()

# --- 7. АДМИНКА STREAMLIT ---
st.set_page_config(page_title="Админка hellopinky")
st.title("🌸 hellopinky Admin")
c1, c2 = st.columns(2)
with c1:
    st.write("### ⏳ Ожидают оплаты")
    for qid, o in state["active_orders"].items():
        st.warning(f"👤 {o['username']} — {o['amt']}₽ ({o['item']})")
with c2:
    st.write("### 📜 Логи")
    st.code("\n".join(reversed(state["logs"])))
    if st.button("🗑 Сбросить кэш таблицы"):
        fetch_cached_sheet.clear()
        st.success("Данные обновлены!")
if st.button("🔄 Обновить панель"): st.rerun()
