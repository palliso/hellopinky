import sys
import streamlit as st
import requests
import time
import base64
import threading
import telebot
from telebot import types
from datetime import datetime

# --- СЕКРЕТЫ ---
MODUL_TOKEN = st.secrets.get("MODUL_TOKEN", "")
CP_ID = st.secrets.get("CP_ID", "")
CP_SECRET = st.secrets.get("CP_SECRET", "")
MY_INN = st.secrets.get("MY_INN", "")
# Токен НОВОГО бота hellopinky
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 

bot = telebot.TeleBot(TG_TOKEN)

# --- ГЛОБАЛЬНАЯ БАЗА ДАННЫХ ---
@st.cache_resource
def get_state():
    return {
        "active_orders": {}, 
        "users": {},  # НОВОЕ: Тут бот будет помнить логины клиентов (chat_id -> username)
        "company_id": None,
        "retail_point_id": None,
        "logs": []
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

# --- ФОНОВЫЙ РОБОТ И БОТ ---
@st.cache_resource
def start_bot():
    if "telegram_bot_running" in sys.modules:
        add_log("⚡ Попытка двойного запуска предотвращена.")
        return True
    sys.modules["telegram_bot_running"] = True

    try: bot.remove_webhook()
    except: pass

    def checker_loop():
        headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
        while True:
            try:
                now_ts = time.time()
                orders = list(state["active_orders"].items())
                
                for qid, order in orders:
                    chat_id = order["chat_id"]
                    
                    if now_ts - order["created_at"] > 900:
                        bot.send_message(chat_id, f"⏳ Время на оплату '{order['item']}' вышло. Заказ отменен. \n\nНажмите /start для новой попытки.")
                        del state["active_orders"][qid]
                        add_log(f"Отменен заказ для юзера {order['username']}")
                        continue

                    r = requests.get(f"https://api.modulbank.ru/v1/sbp/qr-codes/{qid}", headers=headers)
                    if r.status_code == 200:
                        data = r.json()
                        if data.get("status") == "Accepted":
                            bot.send_message(chat_id, f"🎉 Оплата успешно получена, {order['username']}! Чек отправлен на {order['email']}.")
                            add_log(f"💰 Оплата получена от {order['username']}!")
                            
                            send_receipt(data.get("amount", order["amt"]), order["email"], order["item"])
                            del state["active_orders"][qid]
                            
            except Exception as e: pass
            time.sleep(10)

    def telegram_loop():
        # ШАГ 1: АВТОРИЗАЦИЯ
        @bot.message_handler(commands=['start'])
        def welcome_and_auth(message):
            msg = bot.send_message(message.chat.id, "👋 Добро пожаловать!\n\nДля начала работы, пожалуйста, введите ваш логин (юзернейм) в нашей системе:")
            bot.register_next_step_handler(msg, send_welcome_menu)

        # ШАГ 2: КРАСИВОЕ ГЛАВНОЕ МЕНЮ С КНОПКАМИ
        def send_welcome_menu(message):
            username = message.text
            # Запоминаем логин пользователя
            state["users"][message.chat.id] = username 
            
            welcome_text = (
                f"🎉 Авторизация прошла успешно!\n\n"
                f"Добро пожаловать в **hellopinky** — небольшой и уютный магазинчик с официальными боксами от Kayou! 🌸✨\n\n"
                f"По всем вопросам вы можете обратиться к нашим заботливым менеджерам:\n"
                f"💬 @hellopinky_manager\n"
                f"💬 @melamories\n\n"
                f"Что будем делать дальше, {username}?"
            )
            
            # Создаем кнопки
            markup = types.InlineKeyboardMarkup()
            btn_track = types.InlineKeyboardButton("📦 Отследить", callback_data="track")
            btn_pay = types.InlineKeyboardButton("💳 Оплатить", callback_data="pay")
            markup.add(btn_track, btn_pay)
            
            bot.send_message(message.chat.id, welcome_text, reply_markup=markup, parse_mode="Markdown")

        # ШАГ 3: ОБРАБОТКА НАЖАТИЙ НА КНОПКИ
        @bot.callback_query_handler(func=lambda call: True)
        def handle_buttons(call):
            bot.answer_callback_query(call.id) # Убираем "часики" с кнопки
            chat_id = call.message.chat.id
            username = state["users"].get(chat_id, "Гость") # Вспоминаем логин
            
            if call.data == "pay":
                msg = bot.send_message(chat_id, "🛍️ Отлично! Что будем оплачивать? (Напишите название бокса или товара)")
                bot.register_next_step_handler(msg, ask_amount)
                
            elif call.data == "track":
                # Заглушка для кнопки "Отследить"
                bot.send_message(chat_id, "🛠 В данный момент функция отслеживания настраивается. Совсем скоро вы сможете проверять статус своих боксов прямо здесь!")

        # ШАГ 4: ВОРОНКА ОПЛАТЫ
        def ask_amount(message):
            item = message.text
            msg = bot.send_message(message.chat.id, f"Введите сумму к оплате за '{item}' (только цифры):")
            bot.register_next_step_handler(msg, ask_email, item)

        def ask_email(message, item):
            try:
                amt = float(message.text)
                msg = bot.send_message(message.chat.id, "И последнее: напишите ваш E-mail для получения чека:")
                bot.register_next_step_handler(msg, generate_bill, item, amt)
            except ValueError:
                bot.send_message(message.chat.id, "❌ Сумма должна быть числом. Начните заново: /start")

        def generate_bill(message, item, amt):
            email = message.text
            chat_id = message.chat.id
            username = state["users"].get(chat_id, "Гость")

            if "@" not in email:
                bot.send_message(chat_id, "❌ Некорректный E-mail. Начните заново: /start")
                return

            bot.send_message(chat_id, "🔄 Генерирую счет...")
            
            link, qid = create_payment(amt, item)
            if link and qid:
                state["active_orders"][qid] = {
                    "chat_id": chat_id,
                    "username": username,
                    "item": item,
                    "amt": amt,
                    "email": email,
                    "created_at": time.time()
                }
                
                markup = types.InlineKeyboardMarkup()
                markup.add(types.InlineKeyboardButton(text=f"💳 Оплатить {amt} ₽", url=link))
                
                bot.send_message(chat_id, 
                                 f"✅ **Счет готов!**\n\n"
                                 f"👤 Клиент: {username}\n"
                                 f"📦 Заказ: {item}\n"
                                 f"💰 Сумма: {amt} ₽\n\n"
                                 f"⏳ У вас есть ровно 15 минут на оплату.", 
                                 reply_markup=markup, parse_mode="Markdown")
                add_log(f"Счет на {amt}р выставлен для {username}")
            else:
                bot.send_message(chat_id, "❌ Ошибка связи с банком. Попробуйте позже.")

        bot.infinity_polling(timeout=60)

    threading.Thread(target=checker_loop, daemon=True).start()
    threading.Thread(target=telegram_loop, daemon=True).start()
    return True

start_bot()

# --- СЕКРЕТНАЯ АДМИНКА (STREAMLIT UI) ---
st.set_page_config(page_title="Админка hellopinky", layout="centered")
st.title("🤖 Панель управления hellopinky")

col1, col2 = st.columns(2)
with col1:
    st.write("### ⏳ Ждут оплаты:")
    if state["active_orders"]:
        for qid, order in state["active_orders"].items():
            left_mins = int(15 - (time.time() - order['created_at']) / 60)
            st.warning(f"👤 **{order['username']}**\n📦 {order['item']} ({order['amt']}₽)\n📧 {order['email']}\n\nОсталось: {left_mins} мин.")
    else:
        st.success("Очередь пуста")

with col2:
    st.write("### 📜 Логи:")
    st.code("\n".join(reversed(state["logs"])))
    
if st.button("🔄 Обновить", use_container_width=True):
    st.rerun()
