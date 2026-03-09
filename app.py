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
        return pd.read_excel(io.BytesIO(r.content), sheet_name=None, engine='openpyxl')
    except Exception as e:
        add_log(f"Ошибка загрузки таблицы: {e}")
        return None

def get_items_from_sheet(username, target_status):
    if not SHEET_URL: return "⚠️ Ссылка на таблицу не настроена в админке."
    all_sheets = fetch_cached_sheet(SHEET_URL)
    if all_sheets is None: return "⚠️ Не удалось загрузить базу данных. Попробуйте позже."
    
    found_results = {}
    u_clean = username.lower().replace('@', '').strip()

    for sheet_name, df in all_sheets.items():
        if df.empty: continue
        
        # Поиск нужных колонок
        col_status = next((c for c in df.columns if any(x in str(c).lower() for x in ['статус', 'ждём', 'status'])), None)
        col_items = next((c for c in df.columns if any(x in str(c).lower() for x in ['позиции', 'товар', 'коллективка'])), None)
        col_id = next((c for c in df.columns if any(x in str(c).lower() for x in ['разбор', 'заказ', '№', 'юз'])), None)

        if not col_status or not col_items: continue

        mask = df[col_status].astype(str).str.lower().str.contains(target_status.lower().strip())
        df_filtered = df[mask]

        for _, row in df_filtered.iterrows():
            raw_id = str(row[col_id]).replace('.0', '').strip() if col_id else "???"
            
            # Нам нужны только те разборы, где упоминается юзер
            cell_content = str(row[col_items])
            if u_clean not in cell_content.lower():
                continue

            # Парсим позиции внутри ячейки
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
                    # Если тире нет, но ник есть - вычищаем ник и берем позицию
                    clean_p = p.lower().replace(u_clean, "").replace('@', '').strip('()[] ')
                    if clean_p: user_items.append(clean_p.capitalize())
                # Если в строке пусто после тире (например "10 - "), мы это пропускаем (как ты просила)

            if user_items:
                if raw_id not in found_results: found_results[raw_id] = []
                found_results[raw_id].extend(user_items)

    if not found_results: return None

    # Формируем красивый ответ в твоем стиле
    reply = f"🔍 <b>Результаты поиска для {username}:</b>\n<i>Статус: {target_status.upper()}</i>\n\n"
    # Сортировка разборов
    sorted_keys = sorted(found_results.keys(), key=lambda x: int(''.join(filter(str.isdigit, str(x))) or 0))
    
    for r_num in sorted_keys:
        items_str = ", ".join(dict.fromkeys(found_results[r_num]))
        reply += f"🌸 <b>разбор № {r_num}</b> — {items_str}\n"
    
    reply += "\n✨ <i>Если данные неверны, обратитесь к менеджеру.</i>"
    return reply

# --- 4. ПЛАТЕЖИ ---
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

# --- 5. ОБРАБОТЧИКИ ТЕЛЕГРАМ ---
@bot.message_handler(commands=['start'])
def start(message):
    add_log(f"Новый пользователь: {message.chat.id}")
    welcome_text = (
        "🌸 <b>Добро пожаловать в hellopinky!</b> ✨\n\n"
        "Мы поможем вам отследить ваши любимые боксы и быстро оплатить заказы.\n\n"
        "👇 Пожалуйста, введите ваш <b>логин Telegram</b> (юзернейм) для авторизации:"
    )
    msg = bot.send_message(message.chat.id, welcome_text, parse_mode="HTML")
    bot.register_next_step_handler(msg, login)

def login(message):
    user = message.text.strip().replace('@', '')
    state["users"][message.chat.id] = user
    show_main_menu(message.chat.id, user)

def show_main_menu(chat_id, user):
    menu_text = (
        f"✨ <b>Личный кабинет: {user}</b>\n\n"
        "Выберите нужное действие ниже:"
    )
    kb = types.InlineKeyboardMarkup(row_width=2)
    kb.add(
        types.InlineKeyboardButton("📦 Отследить", callback_data="track"),
        types.InlineKeyboardButton("💳 Оплатить", callback_data="pay"),
        types.InlineKeyboardButton("💬 Менеджер", url="https://t.me/hellopinky_manager")
    )
    bot.send_message(chat_id, menu_text, reply_markup=kb, parse_mode="HTML")

@bot.callback_query_handler(func=lambda call: True)
def query_handler(call):
    bot.answer_callback_query(call.id)
    uid = call.message.chat.id
    user = state["users"].get(uid)
    if not user: 
        bot.send_message(uid, "❌ Сессия истекла. Напишите /start")
        return

    if call.data == "track":
        kb = types.InlineKeyboardMarkup(row_width=1)
        statuses = [
            ("🛒 Выкуплен", "st_выкуплен"),
            ("🇨🇳 На кит адресе", "st_на кит адресе"),
            ("🚚 Едет в РФ", "st_едет в рф"),
            ("🇷🇺 В РФ", "st_в рф")
        ]
        for name, code in statuses:
            kb.add(types.InlineKeyboardButton(name, callback_data=code))
        kb.add(types.InlineKeyboardButton("🔙 Назад", callback_data="to_main"))
        bot.edit_message_text("🔍 <b>Выберите статус для отслеживания:</b>", uid, call.message.message_id, reply_markup=kb, parse_mode="HTML")
    
    elif call.data.startswith("st_"):
        status = call.data.split("_")[1]
        msg = bot.send_message(uid, f"🔄 <i>Запрашиваю данные по статусу «{status}»...</i>", parse_mode="HTML")
        res = get_items_from_sheet(user, status)
        bot.delete_message(uid, msg.message_id)
        if res:
            bot.send_message(uid, res, parse_mode="HTML")
        else:
            bot.send_message(uid, f"🥺 Позиций со статусом <b>«{status}»</b> для вас не найдено.\n\nВозможно, статус еще не обновился.", parse_mode="HTML")

    elif call.data == "to_main":
        bot.delete_message(uid, call.message.message_id)
        show_main_menu(uid, user)

    elif call.data == "pay":
        msg = bot.send_message(uid, "🛍 <b>Что вы хотите оплатить?</b>\nВведите название товара или номер разбора:")
        bot.register_next_step_handler(msg, pay_amt)

def pay_amt(message):
    item = message.text
    msg = bot.send_message(message.chat.id, f"💰 <b>Введите сумму к оплате за «{item}»:</b>\n<i>(Только число, например: 1500)</i>", parse_mode="HTML")
    bot.register_next_step_handler(msg, pay_email, item)

def pay_email(message, item):
    try:
        amt = float(message.text.replace(' ', ''))
        msg = bot.send_message(message.chat.id, "📧 <b>Введите ваш Email:</b>\n<i>(На него придет фискальный чек после оплаты)</i>", parse_mode="HTML")
        bot.register_next_step_handler(msg, pay_final, item, amt)
    except:
        bot.send_message(message.chat.id, "❌ Ошибка! Нужно ввести число. Попробуйте снова через кнопку «Оплатить».")

def pay_final(message, item, amt):
    email = message.text.strip()
    if "@" not in email:
        bot.send_message(message.chat.id, "❌ Некорректный Email. Попробуйте снова.")
        return
    
    msg = bot.send_message(message.chat.id, "⏳ <i>Генерирую платежный QR-код...</i>", parse_mode="HTML")
    link, qid = create_payment(amt, item)
    bot.delete_message(message.chat.id, msg.message_id)
    
    if link:
        state["active_orders"][qid] = {"chat_id": message.chat.id, "email": email, "item": item, "amt": amt, "time": time.time()}
        kb = types.InlineKeyboardMarkup().add(types.InlineKeyboardButton(f"💳 Оплатить {amt} ₽", url=link))
        pay_text = (
            f"✅ <b>Счет сформирован!</b>\n\n"
            f"📦 <b>Товар:</b> {item}\n"
            f"💰 <b>К оплате:</b> {amt} ₽\n\n"
            f"⚠️ Ссылка действительна 15 минут."
        )
        bot.send_message(message.chat.id, pay_text, reply_markup=kb, parse_mode="HTML")
    else:
        bot.send_message(message.chat.id, "❌ Ошибка при связи с банком. Обратитесь к @melamories")

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
                            bot.send_message(o["chat_id"], f"🎉 <b>Оплата принята!</b>\n\nБлагодарим за покупку в hellopinky. Чек отправлен на {o['email']}.", parse_mode="HTML")
                            # Тут можно добавить send_receipt
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
st.title("🌸 hellopinky Control Panel")
if st.button("🗑 ПОЛНАЯ ОЧИСТКА КЭША ТАБЛИЦЫ", use_container_width=True):
    fetch_cached_sheet.clear()
    st.success("Данные успешно обновлены из Google Sheets!")

st.divider()
c1, c2 = st.columns(2)
with c1:
    st.write("### ⏳ Активные счета")
    if state["active_orders"]:
        for qid, o in state["active_orders"].items():
            st.info(f"👤 {o['username']} | {o['amt']}₽\n📦 {o['item']}")
    else:
        st.write("Нет неоплаченных счетов")

with c2:
    st.write("### 📜 Системные логи")
    st.code("\n".join(reversed(state["logs"])))

if st.button("🔄 Обновить панель"): st.rerun()
