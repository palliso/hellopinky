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

# --- 1. НАСТРОЙКИ И СЕКРЕТЫ ---
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

# --- 3. ЛОГИКА ТАБЛИЦЫ ---

@st.cache_data(show_spinner=False)
def fetch_cached_sheet(url):
    try:
        export_url = url.split("/edit")[0] + "/export?format=xlsx" if "/edit" in url else url
        headers = {'User-Agent': 'Mozilla/5.0'}
        r = requests.get(export_url, headers=headers, timeout=45)
        if r.status_code != 200: return None
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except Exception as e:
        add_log(f"Ошибка загрузки таблицы: {e}")
        return None

def get_items_from_sheet(username, target_status):
    if not SHEET_URL: return "⚠️ Ссылка на таблицу не настроена."
    all_sheets = fetch_cached_sheet(SHEET_URL)
    if all_sheets is None: return "⚠️ Не удалось загрузить базу данных."
    
    found_results = {}
    # Подготавливаем ник для сравнения (учитываем оба варианта записи)
    u_input = username.lower().strip()
    u_no_at = u_input.replace('@', '')
    u_with_at = f"@{u_no_at}"

    for sheet_name, df in all_sheets.items():
        if df.empty: continue
        
        # Поиск колонок
        col_status = next((c for c in df.columns if any(x in str(c).lower() for x in ['статус', 'ждём', 'status'])), None)
        col_items = next((c for c in df.columns if any(x in str(c).lower() for x in ['позиции', 'товар', 'коллективка'])), None)
        col_id = next((c for c in df.columns if any(x in str(c).lower() for x in ['разбор', 'заказ', '№', 'юз'])), None)

        if not col_status or not col_items: continue

        mask = df[col_status].astype(str).str.lower().str.contains(target_status.lower().strip())
        df_filtered = df[mask]

        for _, row in df_filtered.iterrows():
            raw_id = str(row[col_id]).replace('.0', '').strip() if col_id and pd.notna(row[col_id]) else "???"
            cell_content = str(row[col_items] if col_items in row else "")
            
            # Проверяем наличие ника в ячейке целиком для скорости
            if u_no_at not in cell_content.lower():
                continue

            # Разбиваем ячейку по строкам
            lines = cell_content.split('\n')
            user_items_in_row = []
            
            for line in lines:
                line = line.strip()
                if not line: continue
                
                # Ищем разделитель (тире)
                dash_match = re.search(r'[-—–]', line)
                if dash_match:
                    sep = dash_match.group()
                    parts = line.split(sep)
                    # Владелец — это то, что ПОСЛЕ тире
                    owner_part = parts[-1].lower().strip()
                    # Позиция — то, что ДО тире
                    label_part = sep.join(parts[:-1]).strip()
                    
                    # Если после тире ПУСТО — пропускаем
                    if not owner_part:
                        continue
                        
                    # Если ник совпал (с @ или без)
                    if u_no_at == owner_part.replace('@', '') or u_with_at == owner_part:
                        user_items_in_row.append(label_part)
                
                # Случай без тире, но ник есть (индивидуальные заказы)
                elif u_no_at in line.lower():
                    clean_p = line.lower().replace(u_with_at, "").replace(u_no_at, "").replace('@', '').strip(' ,.()[]')
                    if clean_p: user_items_in_row.append(clean_p.capitalize())

            if user_items_in_row:
                if raw_id not in found_results: found_results[raw_id] = []
                found_results[raw_id].extend(user_items_in_row)

    if not found_results: return None

    # Оформление ответа
    reply = f"🌸 <b>Ваши заказы hellopinky</b> ✨\n"
    reply += f"──────────────────\n"
    reply += f"📂 <i>Статус: {target_status.upper()}</i>\n\n"
    
    try:
        sorted_keys = sorted(found_results.keys(), key=lambda x: int(''.join(filter(str.isdigit, str(x))) or 0))
    except:
        sorted_keys = sorted(found_results.keys())
    
    for r_num in sorted_keys:
        items_list = [i.strip(' ,.') for i in found_results[r_num]]
        # Склеиваем уникальные позиции
        items_str = ", ".join(dict.fromkeys(items_list))
        reply += f"📦 <b>Разбор № {r_num}</b>\n└─ {items_str}\n\n"
    
    reply += f"──────────────────\n"
    reply += f"💌 <i>Есть вопросы? Пишите @hellopinky_manager</i>"
    return reply

# --- 4. ОПЛАТА И БАНК ---
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

# --- 5. ТЕЛЕГРАМ БОТ ---
@bot.message_handler(commands=['start'])
def start(message):
    welcome_text = (
        "🌸 <b>Добро пожаловать в hellopinky!</b> ✨\n\n"
        "Я помогу вам найти ваши заказы в наших разборах и быстро их оплатить.\n\n"
        "📝 Пожалуйста, напишите ваш <b>логин Telegram (с @)</b>, под которым вы записаны в таблице:"
    )
    msg = bot.send_message(message.chat.id, welcome_text, parse_mode="HTML")
    bot.register_next_step_handler(msg, login)

def login(message):
    user = message.text.strip()
    if not user.startswith('@'):
        user = f"@{user}"
    state["users"][message.chat.id] = user
    show_menu(message.chat.id, user)

def show_menu(chat_id, user):
    menu_text = (
        f"🎀 <b>Личный кабинет</b>\n"
        f"👤 Пользователь: <code>{user}</code>\n\n"
        f"Выберите действие ниже:"
    )
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
        types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"),
        types.InlineKeyboardButton("👩‍💻 Менеджер", url="https://t.me/hellopinky_manager")
    )
    bot.send_message(chat_id, menu_text, reply_markup=kb, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_query(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: return bot.send_message(uid, "❌ Ошибка сессии. Введите /start")

    if call.data == "track":
        kb = types.InlineKeyboardMarkup(row_width=1)
        st_list = [("🛒 Выкуплен", "st_выкуплен"), ("🇨🇳 Кит адрес", "st_на кит адресе"), ("🚚 Едет в РФ", "st_едет в рф"), ("🇷🇺 В РФ", "st_в рф")]
        for n, c in st_list: kb.add(types.InlineKeyboardButton(n, callback_data=c))
        kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="back"))
        bot.edit_message_text("🔍 <b>Выберите статус для поиска:</b>", uid, call.message.message_id, reply_markup=kb, parse_mode="HTML")
    
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        load_msg = bot.send_message(uid, "⏳ <i>Ищу ваши боксы в таблицах...</i>", parse_mode="HTML")
        res = get_items_from_sheet(user, status)
        bot.delete_message(uid, load_msg.message_id)
        if res:
            bot.send_message(uid, res, parse_mode="HTML")
        else:
            bot.send_message(uid, f"🥺 По статусу <b>«{status}»</b> для <b>{user}</b> ничего не найдено.\n\nПроверьте, правильно ли указан ник в /start.", parse_mode="HTML")

    elif call.data == "back":
        bot.delete_message(uid, call.message.message_id)
        show_menu(uid, user)

    elif call.data == "pay":
        msg = bot.send_message(uid, "🛍 <b>Что вы хотите оплатить?</b>\n(Например: Разбор №21 или Сет)")
        bot.register_next_step_handler(msg, pay_amt)

def pay_amt(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"💰 <b>Введите сумму за «{item}»:</b>\n(Только цифры)")
    bot.register_next_step_handler(msg, pay_email, item)

def pay_email(message, item):
    try:
        amt = float(message.text.replace(' ', ''))
        bot.send_message(message.chat.id, "📧 <b>Ваш Email для отправки чека:</b>")
        bot.register_next_step_handler(message, pay_final, item, amt)
    except:
        bot.send_message(message.chat.id, "❌ Ошибка! Введите число. Попробуйте нажать «Оплатить» еще раз.")

def pay_final(message, item, amt):
    email = message.text.strip()
    if "@" not in email: return bot.send_message(message.chat.id, "❌ Некорректный Email.")
    
    load = bot.send_message(message.chat.id, "⏳ <i>Связываюсь с банком...</i>", parse_mode="HTML")
    link, qid = create_payment(amt, item)
    bot.delete_message(message.chat.id, load.message_id)
    
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "email": email, "item": item, "amt": amt, "time": time.time()}
        kb = types.InlineKeyboardMarkup().add(types.InlineKeyboardButton(f"💳 Перейти к оплате {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет готов!</b>\n\n📦 {item}\n💰 {amt} ₽", reply_markup=kb, parse_mode="HTML")
    else:
        bot.send_message(message.chat.id, "❌ Ошибка банка. Напишите менеджеру.")

# --- 6. ЗАПУСК ---
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
                            bot.send_message(o["chat_id"], f"🎉 <b>Оплата прошла успешно!</b>\n\nСпасибо за покупку в hellopinky! 🌸 Чек отправлен на почту.", parse_mode="HTML")
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

# --- 7. АДМИНКА ---
st.set_page_config(page_title="hellopinky Admin", page_icon="🌸")
st.title("🌸 hellopinky Management")
if st.button("🗑 ОБНОВИТЬ ДАННЫЕ ИЗ ТАБЛИЦЫ", use_container_width=True):
    fetch_cached_sheet.clear()
    st.success("Таблица успешно перечитана!")

st.divider()
st.write("### 📜 Системные события")
st.code("\n".join(reversed(state["logs"])))
