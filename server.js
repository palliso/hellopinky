// Отключаем проверку SSL-сертификатов для API Модульбанка
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ССЫЛКИ НА GOOGLE ТАБЛИЦУ (TSV) ---
const TSV_ORDERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=0&single=true&output=tsv";
const TSV_PRODUCTS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=538172532&single=true&output=tsv";
const TSV_BOXES = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=1518762544&single=true&output=tsv";

// --- КЛЮЧИ ---
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";

let state = { waiting: {}, history: [], companyId: null, retailPointsMap: { main: null, preorder: null } };
let ozonToken = null, ozonTokenExpiresAt = 0;

function addLog(msg) {
    const now = new Date().toLocaleTimeString('ru-RU');
    state.history.unshift(`[${now}] ${msg}`);
    if (state.history.length > 30) state.history.pop();
    console.log(`[LOG] ${msg}`);
}

// --- АВТОРИЗАЦИЯ OZON ---
async function getOzonToken() {
    if (ozonToken && Date.now() < ozonTokenExpiresAt) return ozonToken;
    try {
        const res = await fetch("https://api-b2b.ozon.ru/v1/auth/login", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: OZON_CLIENT_ID, client_secret: OZON_CLIENT_SECRET })
        });
        if (res.ok) {
            const data = await res.json();
            ozonToken = data.access_token;
            ozonTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
            return ozonToken;
        }
    } catch (e) {}
    return null;
}

// --- ЛОГИКА МОДУЛЬБАНКА (ОПЛАТЫ И ТОЧКИ) ---
async function loadRetailPoints() {
    const headers = { "Authorization": `Bearer ${MODUL_TOKEN}`, "Content-Type": "application/json" };
    try {
        if (!state.companyId) {
            const accRes = await fetch("https://api.modulbank.ru/v1/account-info", { method: "POST", headers });
            if (accRes.ok) {
                const data = await accRes.json();
                state.companyId = data[0]?.companyId || data[0]?.id;
            }
        }
        if (state.companyId) {
            const rpRes = await fetch(`https://api.modulbank.ru/v1/sbp/retail-points?companyId=${state.companyId}`, { method: "GET", headers });
            if (rpRes.ok) {
                const points = await rpRes.json();
                if (points && points.length > 0) {
                    state.retailPointsMap.main = points[0]?.id || null;
                    state.retailPointsMap.preorder = points[1]?.id || points[0]?.id || null;
                }
            }
        }
    } catch (e) {}
}

async function createDynamicQr(amount, description, paymentType) {
    if (!state.retailPointsMap.main || !state.retailPointsMap.preorder) await loadRetailPoints();
    const targetPointId = state.retailPointsMap[paymentType] || state.retailPointsMap.main;
    if (!targetPointId) return { link: null, qrcId: null };

    const payload = { retailPointId: targetPointId, sum: Number(amount), extraInfo: description.substring(0, 140), redirectUrl: REDIRECT_URL };
    try {
        const res = await fetch("https://api.modulbank.ru/v1/sbp/qr-codes/dynamic", { 
            method: "POST", headers: { "Authorization": `Bearer ${MODUL_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) 
        });
        if (res.ok) {
            const data = await res.json();
            return { link: data.payload, qrcId: data.qrcId };
        }
    } catch (e) {}
    return { link: null, qrcId: null };
}

async function sendReceipt(amount, email, itemName) {
    const auth = Buffer.from(`${CP_ID}:${CP_SECRET}`).toString('base64');
    const payload = {
        Inn: MY_INN, Type: "Income",
        CustomerReceipt: { Items: [{ label: itemName, price: Number(amount), quantity: 1, amount: Number(amount), vat: null, method: 1, object: 1 }], taxationSystem: 1, email: email }
    };
    try {
        const res = await fetch("https://api.cloudpayments.ru/kkt/receipt", {
            method: "POST", headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        return res.ok;
    } catch (e) {}
    return false;
}

// Фоновый чекер оплат
setInterval(async () => {
    const headers = { "Authorization": `Bearer ${MODUL_TOKEN}` };
    const now = Date.now();
    for (const [qid, o] of Object.entries(state.waiting)) {
        if (now - o.created_at > 86400000) { delete state.waiting[qid]; continue; }
        try {
            const res = await fetch(`https://api.modulbank.ru/v1/sbp/qr-codes/${qid}`, { method: "GET", headers });
            if (res.ok) {
                const data = await res.json();
                if (data.status === "Accepted") {
                    const success = await sendReceipt(data.amount || o.amount, o.email, o.item);
                    if (success) delete state.waiting[qid];
                }
            }
        } catch (e) {}
    }
}, 10000);

// --- ФУНКЦИЯ ПАРСИНГА TSV ТАБЛИЦ ---
function parseTSV(text) {
    const lines = text.trim().split('\n');
    const headers = lines[0].split('\t').map(h => h.trim());
    return lines.slice(1).map(line => {
        const values = line.split('\t');
        let obj = {};
        headers.forEach((h, i) => obj[h] = values[i] ? values[i].trim() : "");
        return obj;
    });
}

// --- АЛГОРИТМ УПАКОВКИ ---
async function getOptimalPackaging(username) {
    try {
        const [ordRes, prodRes, boxRes] = await Promise.all([ fetch(TSV_ORDERS), fetch(TSV_PRODUCTS), fetch(TSV_BOXES) ]);
        const orders = parseTSV(await ordRes.text());
        const products = parseTSV(await prodRes.text());
        const boxes = parseTSV(await boxRes.text());

        // Очищаем юзернейм от @ и приводим к нижнему регистру для точного поиска
        const cleanUser = username.replace('@', '').trim().toLowerCase();
        
        const userOrders = orders.filter(o => {
            const rowUser = o['Юзернейм'] ? o['Юзернейм'].replace('@', '').trim().toLowerCase() : '';
            return rowUser === cleanUser;
        });

        if (userOrders.length === 0) return { error: "Заказы для этого юзернейма не найдены в таблице." };

        let totalVolume = 0, totalWeight = 0;
        let maxL = 0, maxW = 0, maxH = 0;

        userOrders.forEach(o => {
            const prod = products.find(p => p['Товар'] === o['Товар']);
            if (prod) {
                const qty = parseInt(o['Кол-во']) || 1;
                // Заменяем запятые на точки для корректной математики
                const l = parseFloat((prod['Длина (см)'] || '0').replace(',', '.')) || 0;
                const w = parseFloat((prod['Ширина (см)'] || '0').replace(',', '.')) || 0;
                const h = parseFloat((prod['Высота (см)'] || '0').replace(',', '.')) || 0;
                const weight = parseFloat((prod['Вес (г)'] || '0').replace(',', '.')) || 0;

                totalVolume += (l * w * h) * qty;
                totalWeight += weight * qty;
                
                const dims = [l, w, h].sort((a,b) => b - a);
                if (dims[0] > maxL) maxL = dims[0];
                if (dims[1] > maxW) maxW = dims[1];
                if (dims[2] > maxH) maxH = dims[2];
            }
        });

        if (totalVolume === 0) return { error: "Не удалось определить габариты товаров из Справочника." };

        let selectedBox = null;
        let minBoxVol = Infinity;

        boxes.forEach(b => {
            const bl = parseFloat((b['Длина (см)'] || '0').replace(',', '.'));
            const bw = parseFloat((b['Ширина (см)'] || '0').replace(',', '.'));
            const bh = parseFloat((b['Высота (см)'] || '0').replace(',', '.'));
            const boxWeight = parseFloat((b['Вес пустой (г)'] || '0').replace(',', '.'));
            const matCost = parseFloat((b['Стоимость материалов (₽)'] || '0').replace(',', '.'));

            const boxVol = bl * bw * bh;
            const bDims = [bl, bw, bh].sort((a,b) => b - a);

            // Проверяем, влезает ли общий объем и помещается ли самый длинный предмет
            if (boxVol >= totalVolume && bDims[0] >= maxL && bDims[1] >= maxW && bDims[2] >= maxH) {
                if (boxVol < minBoxVol) {
                    minBoxVol = boxVol;
                    selectedBox = { length: bl, width: bw, height: bh, weight: totalWeight + boxWeight, materialCost: matCost };
                }
            }
        });

        // Если ничего не подошло (товаров слишком много), ставим дефолтную большую коробку Ozon M
        if (!selectedBox) selectedBox = { length: 30, width: 20, height: 15, weight: totalWeight + 150, materialCost: 80 };
        return { success: true, box: selectedBox, itemCount: userOrders.length };

    } catch (e) {
        addLog(`❌ Ошибка чтения таблиц: ${e.message}`);
        return { error: "Не удалось прочитать данные таблицы заказов." };
    }
}

// --- API МАРШРУТЫ ---
app.post('/api/pay', async (req, res) => {
    const { item, amount, email, paymentType } = req.body;
    if (!item || !amount || amount <= 0 || !email) return res.status(400).json({ success: false, error: "Заполните все поля." });

    const { link, qrcId } = await createDynamicQr(amount, item, paymentType || 'main');
    if (link && qrcId) {
        state.waiting[qrcId] = { email, item, amount, created_at: Date.now() };
        return res.json({ success: true, link });
    }
    res.status(500).json({ success: false, error: "Ошибка генерации QR." });
});

// РАСЧЕТ ДОСТАВКИ
app.post('/api/delivery-calc', async (req, res) => {
    const { targetCity, tgUser } = req.body;

    if (!targetCity || !tgUser) return res.status(400).json({ success: false, error: "Укажите ПВЗ и Юзернейм." });

    // 1. Идем в таблицу и собираем коробку
    const packData = await getOptimalPackaging(tgUser);
    if (packData.error) return res.status(400).json({ success: false, error: packData.error });

    const token = await getOzonToken();
    if (!token) return res.status(500).json({ success: false, error: "Ошибка авторизации Ozon." });

    // 2. Спрашиваем цену у Ozon
    const url = "https://api-b2b.ozon.ru/v1/calculator";
    const payload = {
        deliveryType: "PickPoint", 
        fromPlaceId: "Екатеринбург", 
        toPlaceId: targetCity, 
        dimension: { 
            length: Math.ceil(packData.box.length) || 20, 
            width: Math.ceil(packData.box.width) || 15, 
            height: Math.ceil(packData.box.height) || 10, 
            weight: Math.ceil(packData.box.weight) || 300 
        },
        declaredPrice: 0
    };

    try {
        const ozonRes = await fetch(url, {
            method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (ozonRes.ok) {
            const data = await ozonRes.json();
            const ozonTariff = data.price || 0; 
            
            // 3. ЮНИТ-ЭКОНОМИКА: Озон + Коробка + 20р пупырка. И всё это делим на 0.92 для компенсации 8% налога
            const rawCost = ozonTariff + packData.box.materialCost + 20;
            const finalPrice = Math.ceil(rawCost / 0.92);

            res.json({ success: true, deliveryPrice: finalPrice });
        } else {
            const errText = await ozonRes.text();
            addLog(`❌ Ошибка расчета Ozon: ${errText}`);
            res.status(500).json({ success: false, error: "ПВЗ не найден. Уточните адрес." });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Сетевая ошибка расчета." });
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен. Порт ${PORT}`);
    loadRetailPoints(); 
});
