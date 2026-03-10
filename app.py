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

# --- 1. CONFIG ---
MODUL_TOKEN = st.secrets.get("MODUL_TOKEN", "")
CP_ID = st.secrets.get("CP_ID", "")
CP_SECRET = st.secrets.get("CP_SECRET", "")
MY_INN = st.secrets.get("MY_INN", "")
SHEET_URL = st.secrets.get("SHEET_URL", "") 
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 

# --- 2. STATE ---
@st.cache_resource
def init_bot():
    return telebot.TeleBot(TG_TOKEN)

bot = init_bot()

@st.cache_resource
def get_state():
    # users: {chat_id: username}
    return {"active_orders": {}, "users": {}, "logs": [], "bot_running": False}

state = get_state()

def add_log(msg):
    now = datetime.now().strftime("%H:%M:%S")
    state["logs"].append(f"[{now}] {msg}")
    if len(state["logs"]) > 50: state["logs"].pop(0)

# --- 3. DATA LOGIC ---
@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(export_url, headers=headers, timeout=45)
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except Exception as e:
        add_log(f"Ошибка загрузки: {e}")
        return None

def get_items_from_sheet(username, target_status):
    all_sheets = fetch_cached_sheet(SHEET_URL)
    if not all_sheets: return "⚠️ Ошибка базы данных"
    found_data = {}
    u_clean = username.lower().replace('@', '').strip()
    for _, df in all_sheets.items():
        if df.empty: continue
        status_col = next((c for c in df.columns if any(x in str(c).lower() for x in ['статус', 'ждём'])), None)
        item_col = next((c for c in df.columns if any(x in str(c).lower() for x in ['позиции', 'товар'])), None)
        id_col = next((c for c in df.columns if any(x in str(c).lower() for x in ['разбор', '№'])), None)
        if not status_col or not item_col: continue
        mask = df[status_col].astype(str).str.lower().str.contains(target_status.lower().strip())
        df_filtered = df[mask]
        for _, row in df_filtered.iterrows():
            content = str(row[item_col])
            if u_clean not in content.lower(): continue
            r_id = str(row[id_col]).replace('.0', '') if id_col and pd.notna(row[id_col]) else "?"
            lines = content.split('\n')
            for line in lines:
                if u_clean in line.lower() and '-' in line:
                    pos = line.split('-', 1)[0].strip()
                    if pos:
                        if r_id not in found_data: found_data[r_id] = []
                        found_data[r_id].append(pos)
    if not found_data: return None
    reply = f"✨ <b>Заказы hellopinky</b>\n──────────────────\n📂 Статус: <i>{target_status.upper()}</i>\n\n"
    for r_num in sorted(found_data.keys(), key=lambda x: int(''.join(filter(str.isdigit, str(x))) or 0)):
        items_str = ", ".join(dict.fromkeys(found_data[r_num]))
        reply += f"• разбор № {r_num} — <b>{items_str}</b>\n"
    reply += f"──────────────────\n💌 @hellopinky_manager"
    return reply

# --- 4. BANK ---
def create_payment(amount, description):
    try:
        headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
        r_acc = requests.post("https://api.modulbank.ru/v1/account-info", headers=headers).json()
        cid = r_acc[0].get("companyId") or r_acc[0].get("id")
        pts = requests.get(f"https://api.modulbank.ru/v1/sbp/retail-points?companyId={cid}", headers=headers).json()
        rid = pts[0].get("id")
        res = requests.post("https://api.modulbank.ru/v1/sbp/qr-codes/dynamic", 
                            json={"retailPointId": rid, "sum": float(amount), "extraInfo": description[:140], "lifetime": 15},
                            headers=headers).json()
        return res.get("payload"), res.get("qrcId")
    except: return None, None

# --- 5. TELEGRAM ---
@bot.message_handler(commands=['start'])
def start(message):
    welcome_text = (
        "🌸 <b>Приветствуем в hellopinky!</b> ✨\n\n"
        "Я помогу отследить ваши боксы и быстро оплатить позиции.\n\n"
        "Напишите ваш <b>логин Telegram (с @)</b> из таблицы:"
    )
    msg = bot.send_message(message.chat.id, welcome_text, parse_mode="HTML")
    bot.register_next_step_handler(msg, login)

def login(message):
    user = message.text.strip()
    if not user.startswith('@'): user = f"@{user}"
    state["users"][message.chat.id] = user
    show_menu(message.chat.id, user)

def show_menu(chat_id, user):
    menu_text = f"🎀 <b>Личный кабинет, {user}</b>\n\nВыберите нужное действие:"
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
           types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"))
    bot.send_message(chat_id, menu_text, reply_markup=kb, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_query(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: return bot.send_message(uid, "❌ Напишите /start")

    if call.data == "track":
        kb = types.InlineKeyboardMarkup(row_width=1)
        st_list = [("🛒 Выкуплен", "st_выкуплен"), ("🇨🇳 На кит адресе", "st_на кит адресе"), ("🚚 Едет в РФ", "st_едет в рф"), ("🇷🇺 В РФ", "st_в рф")]
        for n, c in st_list: kb.add(types.InlineKeyboardButton(n, callback_data=c))
        kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="back"))
        bot.edit_message_text("🔍 Выберите статус:", uid, call.message.message_id, reply_markup=kb, parse_mode="HTML")
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        res = get_items_from_sheet(user, status)
        bot.send_message(uid, res if res else "Ничего не найдено 🥺", parse_mode="HTML")
    elif call.data == "back":
        bot.delete_message(uid, call.message.message_id)
        show_menu(uid, user)
    elif call.data == "pay":
        msg = bot.send_message(uid, "🛍 <b>Что оплачиваем?</b>")
        bot.register_next_step_handler(msg, pay_amt)

def pay_amt(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"💰 <b>Сумма для «{item}»:</b>")
    bot.register_next_step_handler(msg, pay_email, item)

def pay_email(message, item):
    try:
        amt = float(message.text.replace(' ', ''))
        msg = bot.send_message(message.chat.id, "📧 <b>Ваш Email:</b>")
        bot.register_next_step_handler(message, pay_final, item, amt)
    except: bot.send_message(message.chat.id, "❌ Введите число.")

def pay_final(message, item, amt):
    email = message.text.strip()
    link, qid = create_payment(amt, item)
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "email": email, "item": item, "amt": amt, "time": time.time()}
        kb = types.InlineKeyboardMarkup().add(types.InlineKeyboardButton(f"💳 Оплатить {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет готов</b>\n\n📦 {item}\n💰 {amt} ₽", reply_markup=kb, parse_mode="HTML")
    else: bot.send_message(message.chat.id, "❌ Ошибка банка.")

# --- 6. BACKGROUND TASKS ---
def run_tasks():
    if state["bot_running"]: return
    state["bot_running"] = True
    def check_pay():
        while True:
            for qid, o in list(state["active_orders"].items()):
                if time.time() - o["time"] > 900: del state["active_orders"][qid]
                else:
                    try:
                        r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers={"Authorization": f"Bearer {MODUL_TOKEN}"}).json()
                        if r.get("status") == "Accepted":
                            bot.send_message(o["chat_id"], f"🎉 <b>Оплата прошла!</b>\nЧек на {o['email']}. Спасибо! 🌸", parse_mode="HTML")
                            del state["active_orders"][qid]
                    except: pass
            time.sleep(10)
    def polling():
        while True:
            try: bot.polling(none_stop=True)
            except: time.sleep(5)
    threading.Thread(target=check_pay, daemon=True).start()
    threading.Thread(target=polling, daemon=True).start()

run_tasks()

# --- 7. ADMIN PANEL (NEW SECTION) ---
st.set_page_config(page_title="Admin hellopinky", page_icon="🌸")
st.title("🌸 Панель управления hellopinky")

# Блок 1: Рассылка
st.divider()
st.subheader("📣 Массовая рассылка")
st.write(f"Всего авторизованных пользователей: **{len(state['users'])}**")

broadcast_msg = st.text_area("Введите текст сообщения для всех покупателей:", placeholder="Пример: Девочки, разбор №64 приехал в РФ! Проверяйте статус в боте ✨")

if st.button("🚀 ОТПРАВИТЬ ВСЕМ", use_container_width=True):
    if broadcast_msg:
        success_count = 0
        fail_count = 0
        progress_bar = st.progress(0)
        
        # Список ID тех, кто залогинился
        u_ids = list(state["users"].keys())
        
        for i, chat_id in enumerate(u_ids):
            try:
                bot.send_message(chat_id, f"📢 <b>Важное сообщение:</b>\n\n{broadcast_msg}", parse_mode="HTML")
                success_count += 1
            except Exception as e:
                fail_count += 1
                add_log(f"Ошибка отправки пользователю {chat_id}: {e}")
            
            # Обновляем прогресс-бар
            progress_bar.progress((i + 1) / len(u_ids))
            time.sleep(0.05) # Небольшая пауза, чтобы не спамить в API
            
        st.success(f"Рассылка завершена! ✅ Успешно: {success_count} | ❌ Ошибок: {fail_count}")
        add_log(f"Админ выполнил рассылку на {success_count} чел.")
    else:
        st.error("Введите текст сообщения!")

# Блок 2: База данных
st.divider()
st.subheader("⚙️ Управление данными")
if st.button("🗑 ОБНОВИТЬ ДАННЫЕ ИЗ ТАБЛИЦЫ", use_container_width=True):
    fetch_cached_sheet.clear()
    st.success("Данные успешно перечитаны!")

# Блок 3: Активные заказы и Логи
st.divider()
col_left, col_right = st.columns(2)
with col_left:
    st.write("### ⏳ Ожидают оплаты")
    if state["active_orders"]:
        for q, o in state["active_orders"].items():
            st.info(f"📦 {o['item']} — {o['amt']}₽")
    else: st.write("Нет активных счетов.")

with col_right:
    st.write("### 📜 Системные логи")
    st.code("\n".join(reversed(state["logs"])))
