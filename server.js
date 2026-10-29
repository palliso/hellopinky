process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- ССЫЛКИ НА ТАБЛИЦЫ ---
const TSV_ORDERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=0&single=true&output=tsv";
const TSV_PRODUCTS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=538172532&single=true&output=tsv";
const TSV_BOXES = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=1518762544&single=true&output=tsv";

// --- КЛЮЧИ OZON ---
const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340;

// --- КЛЮЧИ ОПЛАТЫ ---
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

let state = { waiting: {}, history: [], companyId: null, retailPointsMap: { main: null, preorder: null } };
let ozonToken = null, ozonTokenExpiresAt = 0;
let cachedOzonPoints = [];

function addLog(msg) {
    const now = new Date().toLocaleTimeString('ru-RU');
    state.history.unshift(`[${now}] ${msg}`);
    if (state.history.length > 30) state.history.pop();
    console.log(`[LOG] ${msg}`);
}

async function getOzonToken() {
    if (ozonToken && Date.now() < ozonTokenExpiresAt) return { token: ozonToken };
    try {
        const res = await fetch("https://xapi.ozon.ru/oauth/token", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                client_id: OZON_CLIENT_ID, 
                client_secret: OZON_CLIENT_SECRET,
                grant_type: "client_credentials",
                scope: ["delivery-api.delivery", "delivery-api.delivery-point", "delivery-api.order", "delivery-api.posting"]
            })
        });
        if (res.ok) {
            const data = await res.json();
            ozonToken = data.access_token;
            ozonTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
            return { token: ozonToken };
        } else {
            return { error: await res.text() };
        }
    } catch (e) {
        return { error: e.message };
    }
}

// --- СКАЧИВАЕМ И КЭШИРУЕМ АДРЕСА ПВЗ ---
async function fetchOzonPoints() {
    addLog("Загружаем базу адресов Ozon...");
    const auth = await getOzonToken();
    if (auth.error) {
        addLog(`Ошибка токена: ${auth.error}`);
        return;
    }
    try {
        // Качаем до 5000 ПВЗ, чтобы гарантированно покрыть крупные города
        const listRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/list", {
            method: "POST", headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ pagination: { limit: 5000 } })
        });
        const listData = await listRes.json();
        if (!listData.delivery_points) return;
        
        const ids = listData.delivery_points.map(p => p.delivery_point_id);

        const infoRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/info", {
            method: "POST", headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ delivery_point_ids: ids })
        });
        const infoData = await infoRes.json();
        
        cachedOzonPoints = infoData.delivery_points.filter(p => p.is_active).map(p => ({
            id: p.delivery_point_id,
            address: p.full_address
        }));
        addLog(`✅ База загружена: ${cachedOzonPoints.length} ПВЗ.`);
    } catch (e) {
        addLog(`❌ Ошибка скачивания ПВЗ: ${e.message}`);
    }
}
setTimeout(fetchOzonPoints, 2000); // Запускаем при старте сервера

function parseTSV(text) {
    const cleanText = text.replace(/\r/g, '');
    const lines = cleanText.trim().split('\n');
    if (lines.length < 2) return [];
    const headers = lines[0].replace(/^\uFEFF/, '').split('\t').map(h => h.trim().toLowerCase());
    return lines.slice(1).map(line => {
        const values = line.split('\t');
        let obj = {};
        headers.forEach((h, i) => { if (h) obj[h] = values[i] ? values[i].trim() : ""; });
        return obj;
    });
}

async function getOptimalPackaging(username) {
    try {
        const [ordRes, prodRes, boxRes] = await Promise.all([ fetch(TSV_ORDERS), fetch(TSV_PRODUCTS), fetch(TSV_BOXES) ]);
        const orders = parseTSV(await ordRes.text());
        const products = parseTSV(await prodRes.text());
        const boxes = parseTSV(await boxRes.text());

        const cleanUser = username.replace('@', '').trim().toLowerCase();
        const userOrders = orders.filter(o => (o['юзернейм'] || '').replace('@', '').trim().toLowerCase() === cleanUser);
        if (userOrders.length === 0) return { error: "Заказы для этого юзернейма не найдены в таблице." };

        let totalVolume = 0, totalWeight = 0, maxL = 0, maxW = 0, maxH = 0, foundProducts = 0;

        userOrders.forEach(o => {
            const orderItemName = (o['товар (точное название)'] || o['товар'] || o['позиция'] || '').trim().toLowerCase();
            const prod = products.find(p => (p['товар'] || p['позиция'] || '').trim().toLowerCase() === orderItemName && orderItemName !== '');

            if (prod) {
                foundProducts++;
                const qty = parseInt(o['кол-во'] || o['количество'] || '1') || 1;
                const l = parseFloat((prod['длина (см)'] || prod['длина'] || '0').replace(',', '.')) || 0;
                const w = parseFloat((prod['ширина (см)'] || prod['ширина'] || '0').replace(',', '.')) || 0;
                const h = parseFloat((prod['высота (см)'] || prod['высота'] || '0').replace(',', '.')) || 0;
                const weight = parseFloat((prod['вес (г)'] || prod['вес'] || '0').replace(',', '.')) || 0;

                totalVolume += (l * w * h) * qty;
                totalWeight += weight * qty;
                const dims = [l, w, h].sort((a,b) => b - a);
                if (dims[0] > maxL) maxL = dims[0];
                if (dims[1] > maxW) maxW = dims[1];
                if (dims[2] > maxH) maxH = dims[2];
            }
        });

        if (foundProducts === 0 || totalVolume === 0) return { error: "Не удалось определить габариты по справочнику." };

        let selectedBox = null, minBoxVol = Infinity;

        boxes.forEach(b => {
            const bl = parseFloat((b['длина (см)'] || b['длина'] || '0').replace(',', '.'));
            const bw = parseFloat((b['ширина (см)'] || b['ширина'] || '0').replace(',', '.'));
            const bh = parseFloat((b['высота (см)'] || b['высота'] || '0').replace(',', '.'));
            const boxWeight = parseFloat((b['вес пустой (г)'] || b['вес пустой'] || '0').replace(',', '.'));
            const matCost = parseFloat((b['стоимость материалов (₽)'] || b['стоимость материалов'] || '0').replace(',', '.'));
            const boxVol = bl * bw * bh;
            const bDims = [bl, bw, bh].sort((a,b) => b - a);

            if (boxVol >= totalVolume && bDims[0] >= maxL && bDims[1] >= maxW && bDims[2] >= maxH) {
                if (boxVol < minBoxVol) { minBoxVol = boxVol; selectedBox = { length: bl, width: bw, height: bh, weight: totalWeight + boxWeight, materialCost: matCost }; }
            }
        });

        if (!selectedBox) selectedBox = { length: 30, width: 20, height: 15, weight: totalWeight + 150, materialCost: 80 };
        return { success: true, box: selectedBox };
    } catch (e) { return { error: "Ошибка чтения таблиц." }; }
}

// --- УМНЫЙ ПОИСК И РАСЧЕТ ДОСТАВКИ ---
app.post('/api/delivery-calc', async (req, res) => {
    const { targetAddress, tgUser } = req.body;
    if (!targetAddress || !tgUser) return res.status(400).json({ success: false, error: "Укажите ПВЗ и Юзернейм." });

    if (cachedOzonPoints.length === 0) {
        return res.status(500).json({ success: false, error: "База ПВЗ еще загружается, подождите 10 секунд и попробуйте снова." });
    }

    // 1. Умный поиск по тексту (ищем ПВЗ, в адресе которого есть все слова, введенные клиентом)
    const searchTerms = targetAddress.toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
    const foundPvz = cachedOzonPoints.find(p => {
        const addrNorm = p.address.toLowerCase();
        return searchTerms.every(term => addrNorm.includes(term));
    });

    if (!foundPvz) {
        return res.status(400).json({ success: false, error: "ПВЗ не найден. Уточните адрес." });
    }

    // 2. Сборка коробки
    const packData = await getOptimalPackaging(tgUser);
    if (packData.error) return res.status(400).json({ success: false, error: packData.error });

    const authResult = await getOzonToken();
    if (authResult.error) return res.status(500).json({ success: false, error: `Ошибка токена: ${authResult.error}` });

    // 3. Запрос стоимости в Ozon (передаем найденный ID)
    const url = "https://api-delivery.ozon.ru/v1/order/checkout";
    const payload = {
        recipient: { phone_number: "+79990000000" },
        postings: [{
            request_id: 1,
            shipment_method_id: Number(OZON_SHIPMENT_METHOD_ID),
            declared_value: { amount: "100.00", currency_code: "RUB" },
            dimensions: { 
                weight_g: Math.ceil(packData.box.weight), 
                length_mm: Math.ceil(packData.box.length * 10),
                width_mm: Math.ceil(packData.box.width * 10), 
                height_mm: Math.ceil(packData.box.height * 10) 
            }
        }],
        delivery: {
            delivery_point: { delivery_point_id: Number(foundPvz.id) }
        }
    };

    try {
        const ozonRes = await fetch(url, {
            method: "POST", headers: { "Authorization": `Bearer ${authResult.token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (ozonRes.ok) {
            const data = await ozonRes.json();
            const ozonTariff = parseFloat(data.results[0]?.posting?.estimated_delivery_cost?.amount) || 0; 
            const finalPrice = Math.ceil((ozonTariff + packData.box.materialCost + 20) / 0.92);

            // Возвращаем цену и официальный адрес найденного ПВЗ для подтверждения на экране
            res.json({ success: true, deliveryPrice: finalPrice, foundAddress: foundPvz.address });
        } else {
            const errText = await ozonRes.text();
            res.status(500).json({ success: false, error: `Ошибка калькулятора Ozon.` });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Сетевая ошибка расчета." });
    }
});

// ... логика Модульбанка ...
app.post('/api/pay', async (req, res) => { /* Оставляем без изменений */ });

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен. Порт ${PORT}`);
});
