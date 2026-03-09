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
import re

# --- 1. СЕКРЕТЫ ---
MODUL_TOKEN = st.secrets.get("MODUL_TOKEN", "")
CP_ID = st.secrets.get("CP_ID", "")
CP_SECRET = st.secrets.get("CP_SECRET", "")
MY_INN = st.secrets.get("MY_INN", "")
SHEET_URL = st.secrets.get("SHEET_URL", "") 
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 

# --- 2. ИНИЦИАЛИЗАЦИЯ ---
@st.cache_resource
def init_bot():
    return telebot.TeleBot(TG_TOKEN)

bot = init_bot()

@st.cache_resource
def get_state():
    return {"active_orders": {}, "users": {}, "logs": [], "bot_running": False}

state = get_state()

def add_log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    state["logs"].append(f"[{now}] {msg}")
    if len(state["logs"]) > 50: state["logs"].pop(0)

# --- 3. УМНЫЙ ПОИСК (УЛУЧШЕННЫЙ) ---

@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(export_url, headers=headers, timeout=45)
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except Exception as e:
        add_log(f"Ошибка загрузки таблицы: {e}")
        return None

def get_items_from_sheet(username, target_status):
    if not SHEET_URL: return "⚠️ Ссылка на таблицу не настроена."
    all_sheets = fetch_cached_sheet(SHEET_URL)
    if all_sheets is None: return "⚠️ Не удалось загрузить данные."
    
    found_results = {}
    u_clean = username.lower().replace('@', '').strip()

    for sheet_name, df in all_sheets.items():
        if df.empty: continue
        
        # Определяем колонки (очень гибко)
        col_status = next((c for c in df.columns if any(x in str(c).lower() for x in ['статус', 'ждём', 'status'])), None)
        col_items = next((c for c in df.columns if any(x in str(c).lower() for x in ['позиции', 'товар', 'коллективка'])), None)
        col_id = next((c for c in df.columns if any(x in str(c).lower() for x in ['разбор', 'заказ', '№', 'юз'])), None)

        if not col_status or not col_items: continue

        # Фильтруем строки по статусу (вхождение текста)
        mask = df[col_status].astype(str).str.lower().str.contains(target_status.lower().strip())
        df_filtered = df[mask]

        for _, row in df_filtered.iterrows():
            # Определяем заголовок (Разбор №... или Лист...)
            raw_id = str(row[col_id]).replace('.0', '').strip() if col_id else "???"
            header = f"разбор № {raw_id}" if raw_id.isdigit() else f"Лист {sheet_name} ({raw_id})"
            
            cell_content = str(row[col_items])
            # Разбиваем ячейку на части (запятые, точки с запятой, переносы)
            parts = re.split(r'[,\n;]+', cell_content)
            
            user_items = []
            for p in parts:
                p = p.strip()
                if not p: continue
                
                # Ищем разделитель (любое тире)
                dash_match = re.search(r'[-—–]', p)
                if dash_match:
                    sep = dash_match.group()
                    label, owner = p.split(sep, 1)
                    if u_clean in owner.lower().replace('@', ''):
                        user_items.append(label.strip())
                elif u_clean in p.lower():
                    # Если тире нет, но ник есть
                    clean_p = p.lower().replace(u_clean, "").replace('@', '').strip('() ')
                    if clean_p: user_items.append(clean_p.capitalize())

            if user_items:
                if header not in found_results: found_results[header] = []
                found_results[header].extend(user_items)

    if not found_results: return None

    reply = f"🔍 Позиции со статусом <b>«{target_status}»</b> для <b>{username}</b>:\n\n"
    for head, items in found_results.items():
        reply += f"• <b>{head}</b> — {', '.join(dict.fromkeys(items))}\n"
    return reply

# --- 4. БАНК И ОПЛАТА ---
def create_payment(amount, description):
    headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
    try:
        r_acc = requests.post("https://api.modulbank.ru/v1/account-info", headers=headers).json()
        cid = r_acc[0].get("companyId") or r_acc[0].get("id")
        pts = requests.get(f"https://api.modulbank.ru/v1/sbp/retail-points?companyId={cid}", headers=headers).json()
        rid = pts[0].get("id")
        res = requests.post("https://api.modulbank.ru/v1/sbp/qr-codes/dynamic", 
                            json={"retailPointId": rid, "sum": float(amount), "extraInfo": description[:140], "lifetime": 15},
                            headers=headers).json()
        return res.get("payload"), res.get("qrcId")
    except: return None, None

def send_receipt(amount, email, item):
    auth = base64.b64encode(f"{CP_ID}:{CP_SECRET}".encode()).decode()
    payload = {"Inn": MY_INN, "Type": "Income", "CustomerReceipt": {"Items": [{"label": item, "price": amount, "quantity": 1, "amount": amount, "vat": None, "method": 1, "object": 1}], "taxationSystem": 1, "email": email}}
    requests.post("https://api.cloudpayments.ru/kkt/receipt", json=payload, headers={"Authorization": f"Basic {auth}"})

# --- 5. ТЕЛЕГРАМ БОТ ---
@bot.message_handler(commands=['start'])
def start(message):
    msg = bot.send_message(message.chat.id, "👋 Привет! Введите ваш юзернейм:")
    bot.register_next_step_handler(msg, login)

def login(message):
    user = message.text.strip()
    state["users"][message.chat.id] = user
    kb = types.InlineKeyboardMarkup()
    kb.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"), types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.send_message(message.chat.id, f"✅ Привет, {user}! Что делаем?", reply_markup=kb)

@bot.callback_query_handler(func=lambda call: True)
def query_handler(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: return bot.send_message(uid, "Нажмите /start")

    if call.data == "track":
        kb = types.InlineKeyboardMarkup(row_width=1)
        for s in ["выкуплен", "на кит адресе", "едет в рф", "в рф"]:
            kb.add(types.InlineKeyboardButton(s.capitalize(), callback_data=f"st_{s}"))
        bot.edit_message_text("🔍 Выберите статус:", uid, call.message.message_id, reply_markup=kb)
    
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        bot.send_message(uid, f"🔄 Ищу «{status}»...")
        res = get_items_from_sheet(user, status)
        bot.send_message(uid, res if res else "Ничего не найдено 🥺", parse_mode="HTML")

    elif call.data == "pay":
        msg = bot.send_message(uid, "🛍️ Что оплачиваем?")
        bot.register_next_step_handler(msg, pay_amt)

def pay_amt(message):
    bot.send_message(message.chat.id, "Сумма (цифрами):")
    bot.register_next_step_handler(message, pay_email, message.text)

def pay_email(message, item):
    amt = message.text
    bot.send_message(message.chat.id, "Ваш Email:")
    bot.register_next_step_handler(message, pay_final, item, amt)

def pay_final(message, item, amt):
    bot.send_message(message.chat.id, "🔄 Генерирую счет...")
    link, qid = create_payment(amt, item)
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "email": message.text, "item": item, "amt": amt, "time": time.time()}
        kb = types.InlineKeyboardMarkup().add(types.InlineKeyboardButton(f"💳 Оплатить {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет готов!</b>\n📦 {item}\n💰 {amt} ₽", reply_markup=kb, parse_mode="HTML")
    else: bot.send_message(message.chat.id, "Ошибка банка.")

# --- 6. ФОНОВЫЕ ЗАДАЧИ ---
def run_tasks():
    if state["bot_running"]: return
    state["bot_running"] = True
    def check_pay():
        while True:
            for qid, o in list(state["active_orders"].items()):
                if time.time() - o["time"] > 900: del state["active_orders"][qid]
                else:
                    r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers={"Authorization": f"Bearer {MODUL_TOKEN}"}).json()
                    if r.get("status") == "Accepted":
                        bot.send_message(o["chat_id"], "🎉 Оплата принята!")
                        send_receipt(o["amt"], o["email"], o["item"])
                        del state["active_orders"][qid]
            time.sleep(10)
    def polling():
        while True:
            try: bot.polling(none_stop=True)
            except: time.sleep(5)
    threading.Thread(target=check_pay, daemon=True).start()
    threading.Thread(target=polling, daemon=True).start()

run_tasks()

# --- 7. АДМИНКА ---
st.title("🌸 hellopinky Admin")
if st.button("🗑 Полная очистка кэша таблицы"):
    fetch_cached_sheet.clear()
    st.success("Данные обновлены!")
st.write("### 📜 Логи:")
st.code("\n".join(reversed(state["logs"])))
