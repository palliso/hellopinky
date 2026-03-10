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
    u_input = username.lower().strip()
    u_no_at = u_input.replace('@', '')
    u_with_at = f"@{u_no_at}"

    for sheet_name, df in all_sheets.items():
        if df.empty: continue
        
        col_status = next((c for c in df.columns if any(x in str(c).lower() for x in ['статус', 'ждём', 'status'])), None)
        col_items = next((c for c in df.columns if any(x in str(c).lower() for x in ['позиции', 'товар'])), None)
        col_id = next((c for c in df.columns if any(x in str(c).lower() for x in ['разбор', '№'])), None)

        if not col_status or not col_items: continue

        mask = df[col_status].astype(str).str.lower().str.contains(target_status.lower().strip())
        df_filtered = df[mask]

        for _, row in df_filtered.iterrows():
            raw_id = str(row[col_id]).replace('.0', '').strip() if col_id and pd.notna(row[col_id]) else "???"
            cell_content = str(row[col_items] if col_items in row else "")
            
            if u_no_at not in cell_content.lower(): continue

            lines = cell_content.split('\n')
            user_items_in_row = []
            
            for line in lines:
                line = line.strip()
                if not line: continue
                
                dash_match = re.search(r'[-—–]', line)
                if dash_match:
                    sep = dash_match.group()
                    parts = line.split(sep)
                    owner_part = parts[-1].lower().strip()
                    label_part = sep.join(parts[:-1]).strip()
                    
                    if not owner_part: continue
                    if u_no_at == owner_part.replace('@', '') or u_with_at == owner_part:
                        user_items_in_row.append(label_part)
                elif u_no_at in line.lower():
                    clean_p = line.lower().replace(u_with_at, "").replace(u_no_at, "").replace('@', '').strip(' ,.()[]')
                    if clean_p: user_items_in_row.append(clean_p.capitalize())

            if user_items_in_row:
                if raw_id not in found_results: found_results[raw_id] = []
                found_results[raw_id].extend(user_items_in_row)

    if not found_results: return None

    # Оформление: убираем водопад, делаем в строчку
    reply = f"✨ <b>Заказы hellopinky</b>\n"
    reply += f"──────────────────\n"
    reply += f"📂 Статус: <i>{target_status.upper()}</i>\n\n"
    
    try:
        sorted_keys = sorted(found_results.keys(), key=lambda x: int(''.join(filter(str.isdigit, str(x))) or 0))
    except:
        sorted_keys = sorted(found_results.keys())
    
    for r_num in sorted_keys:
        items_list = [i.strip(' ,.') for i in found_results[r_num]]
        items_str = ", ".join(dict.fromkeys(items_list))
        # Формат в одну строку: • разбор № 64 — позиции
        reply += f"• разбор № {r_num} — <b>{items_str}</b>\n"
    
    reply += f"──────────────────\n"
    reply += f"💌 Есть вопросы? Пишите @hellopinky_manager"
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
        "🌸 <b>Приветствуем в hellopinky!</b> ✨\n\n"
        "Мы — уютный магазин официальных боксов и карточек Kayou. Этот бот создан, чтобы "
        "сделать ваше ожидание более комфортным. \n\n"
        "<b>Что я умею:</b>\n"
        "🔎 Мгновенно находить ваши позиции во всех активных разборах.\n"
        "💳 Формировать быстрые счета на оплату через СБП.\n"
        "🧾 Автоматически отправлять чеки на вашу почту.\n\n"
        "Для начала работы, пожалуйста, напишите ваш <b>логин Telegram (с @)</b>, "
        "под которым вы записаны в нашей таблице заказов:"
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
        f"🎀 <b>Добро пожаловать в кабинет, {user}!</b>\n\n"
        f"Здесь вы можете отследить статус своих заказов (от выкупа в Китае до прибытия в РФ) "
        f"или оплатить новые позиции.\n\n"
        f"Если у вас возникли сложности, наши менеджеры всегда на связи:\n"
        f"💬 @hellopinky_manager\n"
        f"💬 @melamories\n\n"
        f"<b>Выберите нужное действие:</b>"
    )
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
        types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"),
        types.InlineKeyboardButton("👩‍💻 Помощь", url="https://t.me/hellopinky_manager")
    )
    bot.send_message(chat_id, menu_text, reply_markup=kb, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def handle_query(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: return bot.send_message(uid, "❌ Сессия истекла. Напишите /start")

    if call.data == "track":
        kb = types.InlineKeyboardMarkup(row_width=1)
        st_list = [("🛒 Выкуплен", "st_выкуплен"), ("🇨🇳 На кит адресе", "st_на кит адресе"), ("🚚 Едет в РФ", "st_едет в рф"), ("🇷🇺 В РФ", "st_в рф")]
        for n, c in st_list: kb.add(types.InlineKeyboardButton(n, callback_data=c))
        kb.add(types.InlineKeyboardButton("🔙 Назад в меню", callback_data="back"))
        bot.edit_message_text("🔍 <b>Выберите этап доставки:</b>", uid, call.message.message_id, reply_markup=kb, parse_mode="HTML")
    
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        load_msg = bot.send_message(uid, "⏳ <i>Сканирую базу данных...</i>", parse_mode="HTML")
        res = get_items_from_sheet(user, status)
        bot.delete_message(uid, load_msg.message_id)
        if res:
            bot.send_message(uid, res, parse_mode="HTML")
        else:
            bot.send_message(uid, f"🥺 По статусу <b>«{status}»</b> для вас ничего не найдено.\n\nВозможно, данные еще не обновились в таблице или логин указан неверно.", parse_mode="HTML")

    elif call.data == "back":
        bot.delete_message(uid, call.message.message_id)
        show_menu(uid, user)

    elif call.data == "pay":
        msg = bot.send_message(uid, "🛍 <b>Что вы хотите оплатить?</b>\nНапишите название товара или номер разбора:")
        bot.register_next_step_handler(msg, pay_amt)

def pay_amt(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"💰 <b>Какую сумму нужно оплатить за «{item}»?</b>\n(Только цифры)")
    bot.register_next_step_handler(msg, pay_email, item)

def pay_email(message, item):
    try:
        amt = float(message.text.replace(' ', ''))
        msg = bot.send_message(message.chat.id, "📧 <b>Укажите ваш Email:</b>\nНа него банк отправит официальный чек после оплаты.")
        bot.register_next_step_handler(message, pay_final, item, amt)
    except:
        bot.send_message(message.chat.id, "❌ Пожалуйста, введите только число. Нажмите «Оплатить» в меню еще раз.")

def pay_final(message, item, amt):
    email = message.text.strip()
    if "@" not in email: return bot.send_message(message.chat.id, "❌ Email указан неверно. Попробуйте снова.")
    
    load = bot.send_message(message.chat.id, "⏳ <i>Генерирую QR-код СБП...</i>", parse_mode="HTML")
    link, qid = create_payment(amt, item)
    bot.delete_message(message.chat.id, load.message_id)
    
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "email": email, "item": item, "amt": amt, "time": time.time()}
        kb = types.InlineKeyboardMarkup().add(types.InlineKeyboardButton(f"💳 Оплатить {amt} ₽", url=link))
        bot.send_message(message.chat.id, f"✅ <b>Счет сформирован!</b>\n\n📦 Заказ: {item}\n💰 К оплате: {amt} ₽\n\n<i>После оплаты вам автоматически придет сообщение с подтверждением.</i>", reply_markup=kb, parse_mode="HTML")
    else:
        bot.send_message(message.chat.id, "❌ Ошибка связи с банком. Пожалуйста, попробуйте позже.")

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
                            bot.send_message(o["chat_id"], f"🎉 <b>Оплата прошла успешно!</b>\n\nМы получили ваш перевод за «{o['item']}». Электронный чек уже летит к вам на почту {o['email']}. Спасибо за доверие! 🌸", parse_mode="HTML")
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
st.title("🌸 Панель управления hellopinky")

if st.button("🗑 ПЕРЕЗАГРУЗИТЬ БАЗУ ДАННЫХ", use_container_width=True):
    fetch_cached_sheet.clear()
    st.success("Данные из Google Таблицы успешно обновлены!")

st.divider()
st.write("### 📜 Логи системы")
st.code("\n".join(reversed(state["logs"])))
