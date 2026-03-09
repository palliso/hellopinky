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

# --- ИНИЦИАЛИЗАЦИЯ ---
@st.cache_resource
def init_bot():
    return telebot.TeleBot(TG_TOKEN)

bot = init_bot()

@st.cache_resource
def get_state():
    return {"active_orders": {}, "users": {}, "company_id": None, "retail_point_id": None, "logs": [], "bot_running": False}

state = get_state()

def add_log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    state["logs"].append(f"[{now}] {msg}")
    if len(state["logs"]) > 50: state["logs"].pop(0)

# --- РАБОТА С БАНКОМ ---
def get_retail_id():
    headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
    try:
        if not state["company_id"]:
            r_acc = requests.post("https://api.modulbank.ru/v1/account-info", headers=headers)
            state["company_id"] = r_acc.json()[0].get("companyId") or r_acc.json()[0].get("id")
        url = f"https://api.modulbank.ru/v1/sbp/retail-points?companyId={state['company_id']}"
        return requests.get(url, headers=headers).json()[0].get("id")
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
    payload = {"Inn": MY_INN, "Type": "Income", "CustomerReceipt": {"Items": [{"label": item_name, "price": amount, "quantity": 1, "amount": amount, "vat": None, "method": 1, "object": 1}], "taxationSystem": 1, "email": email}}
    try: requests.post("https://api.cloudpayments.ru/kkt/receipt", json=payload, headers={"Authorization": f"Basic {auth}"})
    except: pass

# --- КЭШ ТАБЛИЦЫ ---
@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(export_url, headers=headers, timeout=45)
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except: return None

# --- ЭСТЕТИЧНЫЙ ПОИСК ---
def get_items_from_sheet(username, target_status):
    if not SHEET_URL: return "⚠️ Настройте ссылку в админке."
    try:
        all_sheets = fetch_cached_sheet(SHEET_URL)
        if all_sheets is None: return "⚠️ Ошибка загрузки базы."
        
        found_data = {}
        u_clean = username.lower().replace('@', '').strip()

        for sheet_name, df in all_sheets.items():
            if df.empty: continue
            
            status_col = next((c for c in df.columns if 'статус' in str(c).lower()), None)
            item_col = next((c for c in df.columns if 'позиции' in str(c).lower()), None)
            razbor_col = next((c for c in df.columns if 'разбор' in str(c).lower()), None)
            
            if not status_col or not item_col: continue 
                
            df_status = df[df[status_col].astype(str).str.lower().str.strip() == target_status.lower()]
            
            for _, row in df_status.iterrows():
                cell_text = str(row[item_col])
                if u_clean not in cell_text.lower(): continue

                razbor_num = str(row[razbor_col]).replace('.0', '') if razbor_col and pd.notna(row[razbor_col]) else "?"
                parts = cell_text.replace('\n', ',').split(',')
                
                for part in parts:
                    if u_clean in part.lower():
                        pos = part.split('-', 1)[0].strip() if '-' in part else part.lower().replace(u_clean, '').replace('@', '').strip()
                        if pos:
                            if razbor_num not in found_data: found_data[razbor_num] = []
                            found_data[razbor_num].append(pos)

        if not found_data: return None
            
        # Формируем эстетичный ответ
        res_text = f"✨ <b>Ваши заказы hellopinky</b>\n"
        res_text += f"──────────────────\n"
        res_text += f"📂 Статус: <i>{target_status.upper()}</i>\n\n"
        
        for r_num, items in found_data.items():
            items_str = ", ".join(dict.fromkeys(items))
            res_text += f"• разбор № {r_num} — <b>{items_str}</b>\n"
        
        res_text += f"\n──────────────────\n"
        res_text += f"💌 @hellopinky_manager"
        
        return res_text
    except: return "⚠️ Ошибка поиска."

# --- ТЕЛЕГРАМ ЛОГИКА ---
bot.message_handlers = []
bot.callback_query_handlers = []

@bot.message_handler(commands=['start'])
def welcome(message):
    msg = bot.send_message(message.chat.id, "🌸 Привет! Введите ваш логин:")
    bot.register_next_step_handler(msg, main_menu)

def main_menu(message):
    username = message.text
    state["users"][message.chat.id] = username 
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
               types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    
    welcome_text = (
        f"✨ <b>Авторизация прошла успешно!</b>\n\n"
        f"Добро пожаловать, <b>{username}</b>. Мы рады тебя видеть в hellopinky 🌸\n\n"
        f"Выбери нужное действие ниже:"
    )
    bot.send_message(message.chat.id, welcome_text, reply_markup=markup, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_call(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: return bot.send_message(uid, "Пожалуйста, нажми /start")

    if call.data == "track":
        m = types.InlineKeyboardMarkup(row_width=1)
        m.add(types.InlineKeyboardButton("🛒 Выкуплен", callback_data="st_выкуплен"),
              types.InlineKeyboardButton("🇨🇳 На кит адресе", callback_data="st_на кит адресе"),
              types.InlineKeyboardButton("🚚 Едет в РФ", callback_data="st_едет в рф"),
              types.InlineKeyboardButton("🇷🇺 В РФ", callback_data="st_в рф"),
              types.InlineKeyboardButton("🔙 Назад", callback_data="back"))
        bot.edit_message_text("✨ <b>Выбери статус для проверки:</b>", uid, call.message.message_id, reply_markup=m, parse_mode="HTML")
    
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        res = get_items_from_sheet(user, status)
        bot.send_message(uid, res if res else "Ничего не найдено 🥺", parse_mode="HTML")

    elif call.data == "back":
        main_menu_back(call.message, user)

    elif call.data == "pay":
        msg = bot.send_message(uid, "📝 Что мы оплачиваем сегодня?")
        bot.register_next_step_handler(msg, ask_amt)

def main_menu_back(message, user):
    markup = types.InlineKeyboardMarkup(row_width=2)
    markup.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
               types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.edit_message_text(f"✨ <b>Главное меню</b>\n\nЧем я могу помочь, {user}?", message.chat.id, message.message_id, reply_markup=markup, parse_mode="HTML")

def ask_amt(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"💳 Введи сумму для <b>{item}</b>:", parse_mode="HTML")
    bot.register_next_step_handler(msg, ask_mail, item)

def ask_mail(message, item):
    try:
        amt = float(message.text)
        msg = bot.send_message(message.chat.id, "📧 Твой E-mail для чека:")
        bot.register_next_step_handler(msg, finish_pay, item, amt)
    except: bot.send_message(message.chat.id, "❌ Нужно ввести число. Начни заново: /start")

def finish_pay(message, item, amt):
    mail = message.text
    bot.send_message(message.chat.id, "🔄 Формирую безопасную ссылку...")
    link, qid = create_payment(amt, item)
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "item": item, "amt": amt, "mail": mail, "ts": time.time(), "user": state["users"].get(message.chat.id)}
        markup = types.InlineKeyboardMarkup()
        markup.add(types.InlineKeyboardButton(f"💳 Оплатить {amt} ₽", url=link))
        
        pay_text = (
            f"✅ <b>Счет успешно сформирован!</b>\n"
            f"──────────────────\n"
            f"📦 <b>Товар:</b> {item}\n"
            f"💰 <b>К оплате:</b> {amt} ₽\n"
            f"──────────────────\n"
            f"⏳ Ссылка активна 15 минут."
        )
        bot.send_message(message.chat.id, pay_text, reply_markup=markup, parse_mode="HTML")
    else: bot.send_message(message.chat.id, "❌ Ошибка банка. Попробуй позже.")

# --- ФОНОВЫЕ ЗАДАЧИ ---
@st.cache_resource
def start_tasks():
    if state["bot_running"]: return
    state["bot_running"] = True
    def checker():
        while True:
            for qid, o in list(state["active_orders"].items()):
                if time.time() - o["ts"] > 900: del state["active_orders"][qid]
                else:
                    try:
                        r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers={"Authorization": f"Bearer {MODUL_TOKEN}"})
                        if r.status_code == 200 and r.json().get("status") == "Accepted":
                            bot.send_message(o["chat_id"], f"🎉 <b>Оплата получена!</b>\n\nЧек отправлен на {o['mail']}. Спасибо за заказ! ✨", parse_mode="HTML")
                            send_receipt(o["amt"], o["mail"], o["item"])
                            del state["active_orders"][qid]
                    except: pass
            time.sleep(10)
    def poller():
        while True:
            try: bot.polling(none_stop=True, interval=2)
            except: time.sleep(10)
    threading.Thread(target=checker, daemon=True).start()
    threading.Thread(target=poller, daemon=True).start()

start_tasks()

# --- АДМИНКА ---
st.title("🤖 Hellopinky Admin")
st.write("──────────────────")
if st.button("🗑 Сбросить кэш таблицы"):
    fetch_cached_sheet.clear()
    st.success("Данные таблицы обновлены!")

if state["active_orders"]:
    st.write("### ⏳ Активные счета:")
    for q, o in state["active_orders"].items():
        st.info(f"👤 {o.get('user')} | 📦 {o['item']} — {o['amt']}₽")
else:
    st.write("Ожидающих оплат нет.")
