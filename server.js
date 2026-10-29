// Отключаем проверку SSL-сертификатов для API Модульбанка
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());

// Раздаем статические файлы (HTML, CSS, JS) из папки public
app.use(express.static(path.join(__dirname, 'public')));

// --- КЛЮЧИ МОДУЛЬБАНКА И CLOUDPAYMENTS ---
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

// --- КЛЮЧИ OZON ДОСТАВКИ ---
const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";

let state = {
    waiting: {},
    history: [],
    companyId: null,
    retailPointsMap: {
        main: null,
        preorder: null
    }
};

let ozonToken = null;
let ozonTokenExpiresAt = 0;

function addLog(msg) {
    const now = new Date().toLocaleTimeString('ru-RU');
    state.history.unshift(`[${now}] ${msg}`);
    if (state.history.length > 30) state.history.pop();
    console.log(`[LOG] ${msg}`);
}

// --- ЛОГИКА OZON ДОСТАВКИ ---
async function getOzonToken() {
    if (ozonToken && Date.now() < ozonTokenExpiresAt) {
        return ozonToken;
    }

    const url = "https://api-b2b.ozon.ru/v1/auth/login";
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: OZON_CLIENT_ID,
                client_secret: OZON_CLIENT_SECRET
            })
        });
        
        if (res.ok) {
            const data = await res.json();
            ozonToken = data.access_token;
            // Сохраняем токен и вычитаем 60 секунд для запаса надежности
            ozonTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
            addLog("✅ Успешно получен токен Ozon Доставки");
            return ozonToken;
        } else {
            addLog(`❌ Ошибка авторизации Ozon: ${await res.text()}`);
        }
    } catch (e) {
        addLog(`❌ Сетевая ошибка Ozon Auth: ${e.message}`);
    }
    return null;
}

async function createDynamicQr(amount, description, paymentType) {
    if (!state.retailPointsMap.main || !state.retailPointsMap.preorder) {
        await loadRetailPoints();
    }

    const targetPointId = state.retailPointsMap[paymentType] || state.retailPointsMap.main;

    if (!targetPointId) {
        addLog(`❌ Не найден retailPointId для типа оплаты: ${paymentType}`);
        return { link: null, qrcId: null };
    }

    const url = "https://api.modulbank.ru/v1/sbp/qr-codes/dynamic";
    const headers = { "Authorization": `Bearer ${MODUL_TOKEN}`, "Content-Type": "application/json" };
    const payload = {
        retailPointId: targetPointId,
        sum: Number(amount),
        extraInfo: description.substring(0, 140),
        redirectUrl: REDIRECT_URL
    };

    try {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
        if (res.ok) {
            const data = await res.json();
            return { link: data.payload, qrcId: data.qrcId };
        } else {
            const errText = await res.text();
            addLog(`❌ Ошибка создания QR от Модульбанка (${res.status}): ${errText}`);
        }
    } catch (e) {
        addLog(`❌ Сетевая ошибка при создании QR: ${e.message}`);
    }
    return { link: null, qrcId: null };
}

async function sendReceipt(amount, email, itemName) {
    const auth = Buffer.from(`${CP_ID}:${CP_SECRET}`).toString('base64');
    const payload = {
        Inn: MY_INN,
        Type: "Income",
        CustomerReceipt: {
            Items: [{ label: itemName, price: Number(amount), quantity: 1, amount: Number(amount), vat: null, method: 1, object: 1 }],
            taxationSystem: 1,
            email: email
        }
    };

    try {
        const res = await fetch("https://api.cloudpayments.ru/kkt/receipt", {
            method: "POST",
            headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            return true;
        } else {
            const errReceipt = await res.text();
            addLog(`❌ Ошибка пробития чека CloudKassir (${res.status}): ${errReceipt}`);
            return false;
        }
    } catch (e) {
        addLog(`❌ Исключение при отправке чека: ${e.message}`);
        return false;
    }
}

// Фоновый робот проверки статуса СБП
setInterval(async () => {
    const headers = { "Authorization": `Bearer ${MODUL_TOKEN}` };
    const now = Date.now();

    for (const [qid, o] of Object.entries(state.waiting)) {
        if (now - o.created_at > 86400000) {
            delete state.waiting[qid];
            continue;
        }
        try {
            const res = await fetch(`https://api.modulbank.ru/v1/sbp/qr-codes/${qid}`, { method: "GET", headers });
            if (res.ok) {
                const data = await res.json();
                if (data.status === "Accepted") {
                    const success = await sendReceipt(data.amount || o.amount, o.email, o.item);
                    if (success) {
                        delete state.waiting[qid];
                        addLog(`✅ Оплата получена, чек для ${o.email} (${o.amount} ₽) успешно отправлен!`);
                    }
                }
            }
        } catch (e) {}
    }
}, 10000);

// --- API МАРШРУТЫ ---

// 1. Оплата СБП
app.post('/api/pay', async (req, res) => {
    const { item, amount, email, paymentType } = req.body;
    if (!item || !amount || amount <= 0 || !email) {
        return res.status(400).json({ success: false, error: "Заполните все поля." });
    }

    const { link, qrcId } = await createDynamicQr(amount, item, paymentType || 'main');
    if (link && qrcId) {
        state.waiting[qrcId] = { email, item, amount, created_at: Date.now() };
        addLog(`🌸 Создан СБП QR (${paymentType || 'main'}) для ${email} на сумму ${amount} ₽ (${item})`);
        return res.json({ success: true, link });
    }

    res.status(500).json({ success: false, error: "Ошибка генерации QR в Модульбанке. Проверьте логи сервера." });
});

// 2. Расчет доставки Ozon
app.post('/api/delivery-calc', async (req, res) => {
    const { targetCity, cartValue } = req.body;

    if (!targetCity) {
        return res.status(400).json({ success: false, error: "Не указан город" });
    }

    const token = await getOzonToken();
    if (!token) {
        return res.status(500).json({ success: false, error: "Ошибка авторизации Ozon" });
    }

    const url = "https://api-b2b.ozon.ru/v1/calculator";
    const payload = {
        deliveryType: "PickPoint", // Доставка до ПВЗ
        fromPlaceId: "Екатеринбург", // Ваш город отправки
        toPlaceId: targetCity, 
        dimension: {
            length: 20,
            width: 15,
            height: 10,
            weight: 300 // Базовый вес в граммах 
        },
        declaredPrice: cartValue || 0
    };

    try {
        const ozonRes = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        if (ozonRes.ok) {
            const data = await ozonRes.json();
            const price = data.price || 0; 
            res.json({ success: true, deliveryPrice: Math.ceil(price), payloadUsed: payload });
        } else {
            const errText = await ozonRes.text();
            addLog(`❌ Ошибка расчета Ozon (${ozonRes.status}): ${errText}`);
            res.status(500).json({ success: false, error: "Ошибка тарификации Ozon" });
        }
    } catch (e) {
        addLog(`❌ Сетевая ошибка при расчете Ozon: ${e.message}`);
        res.status(500).json({ success: false, error: "Сетевая ошибка" });
    }
});

// 3. Логи для мониторинга
app.get('/api/logs', (req, res) => {
    res.json({ waiting: Object.keys(state.waiting).length, history: state.history });
});

// Гарантированный возврат главной страницы
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен и слушает порт ${PORT}`);
    loadRetailPoints(); // Подтягиваем точки Модульбанка при старте
});
