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
TG_TOKEN = "8002202165:AAFKdN4bW6Eox1jxRDnJgzjz1Bo9Ny2xX1s" 

bot = telebot.TeleBot(TG_TOKEN)

# --- ГЛОБАЛЬНАЯ БАЗА ДАННЫХ ---
@st.cache_resource
def get_state():
    return {
        "active_orders": {}, 
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

# --- ФОНОВЫЙ РОБОТ ---
@st.cache_resource
def start_bot():
    def checker_loop():
        headers = {"Authorization": f"Bearer {MODUL_TOKEN}"}
        while True:
            try:
                now_ts = time.time()
                orders = list(state["active_orders"].items())
                
                for qid, order in orders:
                    chat_id = order["chat_id"]
                    
                    # ПРОВЕРКА ДЕДЛАЙНА
                    if now_ts - order["created_at"] > 900:
                        bot.send_message(chat_id, f"⏳ Время на оплату '{order['item']}' вышло. Заказ отменен. \n\nНажмите /start для новой попытки.")
                        del state["active_orders"][qid]
                        add_log(f"Отменен заказ для юзера {order['username']}")
                        continue

                    # ПРОВЕРКА БАНКА
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
        # ШАГ 1: ПРИВЕТСТВИЕ И АВТОРИЗАЦИЯ
        @bot.message_handler(commands=['start'])
        def welcome_and_auth(message):
            msg = bot.send_message(message.chat.id, "👋 Добро пожаловать!\n\nДля продолжения работы, пожалуйста, авторизуйтесь: напишите ваш логин (юзернейм) в нашей системе.")
            bot.register_next_step_handler(msg, ask_item)

        # ШАГ 2: СПРАШИВАЕМ ТОВАР
        def ask_item(message):
            username = message.text
            msg = bot.send_message(message.chat.id, f"✅ Отлично, {username}! Вы успешно авторизованы.\n\nЧто будем оплачивать? (Напишите название товара или услуги)")
            # Передаем юзернейм дальше по цепочке
            bot.register_next_step_handler(msg, ask_amount, username)

        # ШАГ 3: СПРАШИВАЕМ СУММУ
        def ask_amount(message, username):
            item = message.text
            msg = bot.send_message(message.chat.id, f"Введите сумму к оплате за '{item}' (только цифры):")
            bot.register_next_step_handler(msg, ask_email, username, item)

        # ШАГ 4: СПРАШИВАЕМ ПОЧТУ
        def ask_email(message, username, item):
            try:
                amt = float(message.text)
                msg = bot.send_message(message.chat.id, "И последнее: напишите ваш E-mail для получения чека:")
                bot.register_next_step_handler(msg, generate_bill, username, item, amt)
            except ValueError:
                bot.send_message(message.chat.id, "❌ Сумма должна быть числом. Начните заново: /start")

        # ШАГ 5: ВЫДАЕМ ССЫЛКУ
        def generate_bill(message, username, item, amt):
            email = message.text
            if "@" not in email:
                bot.send_message(message.chat.id, "❌ Некорректный E-mail. Начните заново: /start")
                return

            bot.send_message(message.chat.id, "🔄 Генерирую счет...")
            
            link, qid = create_payment(amt, item)
            if link and qid:
                # Теперь мы сохраняем и логин клиента тоже!
                state["active_orders"][qid] = {
                    "chat_id": message.chat.id,
                    "username": username,
                    "item": item,
                    "amt": amt,
                    "email": email,
                    "created_at": time.time()
                }
                
                markup = types.InlineKeyboardMarkup()
                markup.add(types.InlineKeyboardButton(text=f"💳 Оплатить {amt} ₽", url=link))
                
                bot.send_message(message.chat.id, 
                                 f"✅ **Счет готов!**\n\n"
                                 f"👤 Клиент: {username}\n"
                                 f"📦 Заказ: {item}\n"
                                 f"💰 Сумма: {amt} ₽\n\n"
                                 f"⏳ Оплатите счет в течение 15 минут.", 
                                 reply_markup=markup, parse_mode="Markdown")
                add_log(f"Счет на {amt}р выставлен для {username} ({email})")
            else:
                bot.send_message(message.chat.id, "❌ Ошибка связи с банком. Попробуйте позже.")

        bot.infinity_polling()

    threading.Thread(target=checker_loop, daemon=True).start()
    threading.Thread(target=telegram_loop, daemon=True).start()
    return True

start_bot()

# --- СЕКРЕТНАЯ АДМИНКА ---
st.set_page_config(page_title="Админка бота", layout="centered")
st.title("🤖 Панель управления")

col1, col2 = st.columns(2)
with col1:
    st.write("### ⏳ Ждут оплаты:")
    if state["active_orders"]:
        for qid, order in state["active_orders"].items():
            left_mins = int(15 - (time.time() - order['created_at']) / 60)
            # В админке теперь видно логин!
            st.warning(f"👤 **{order['username']}**\n📦 {order['item']} ({order['amt']}₽)\n📧 {order['email']}\n\nОсталось: {left_mins} мин.")
    else:
        st.success("Очередь пуста")

with col2:
    st.write("### 📜 Логи:")
    st.code("\n".join(reversed(state["logs"])))
    
if st.button("🔄 Обновить", use_container_width=True):
    st.rerun()
