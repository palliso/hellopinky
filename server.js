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

// --- КЛЮЧИ OZON (ОБЯЗАТЕЛЬНО ЗАПОЛНИ!) ---
const OZON_CLIENT_ID = "ТВОЙ_CLIENT_ID";
const OZON_CLIENT_SECRET = "ТВОЙ_CLIENT_SECRET";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340; // ВАЖНО: ID твоего метода доставки из кабинета Ozon

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

// --- НОВАЯ АВТОРИЗАЦИЯ OZON DELIVERY API ---
async function getOzonToken() {
    if (ozonToken && Date.now() < ozonTokenExpiresAt) return { token: ozonToken };
    try {
        const res = await fetch("https://xapi.ozon.ru/oauth/token", {
            method: "POST", 
            headers: { "Content-Type": "application/json" },
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

// --- СКАЧИВАНИЕ БАЗЫ ПВЗ ДЛЯ КАРТЫ ---
async function fetchOzonPoints() {
    addLog("Скачиваем базу ПВЗ Ozon...");
    const auth = await getOzonToken();
    if (auth.error) {
        addLog(`Ошибка токена ПВЗ: ${auth.error}`);
        return;
    }

    try {
        // 1. Получаем список ID
        const listRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/list", {
            method: "POST", headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ pagination: { limit: 1000 } }) // Для примера берем первую 1000
        });
        const listData = await listRes.json();
        if (!listData.delivery_points) return;

        const ids = listData.delivery_points.map(p => p.delivery_point_id);

        // 2. Получаем координаты и адреса по ID
        const infoRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/info", {
            method: "POST", headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ delivery_point_ids: ids })
        });
        const infoData = await infoRes.json();
        
        cachedOzonPoints = infoData.delivery_points.filter(p => p.is_active).map(p => ({
            id: p.delivery_point_id,
            name: p.name,
            address: p.full_address,
            coords: [p.coordinates.latitude, p.coordinates.longitude]
        }));
        addLog(`✅ Успешно загружено ${cachedOzonPoints.length} ПВЗ для карты.`);
    } catch (e) {
        addLog(`❌ Ошибка скачивания ПВЗ: ${e.message}`);
    }
}

// Запускаем скачивание ПВЗ при старте сервера
setTimeout(fetchOzonPoints, 2000);

// Отдаем ПВЗ на фронтенд для карты
app.get('/api/pvz-map-data', (req, res) => {
    res.json({ success: true, points: cachedOzonPoints });
});


// --- ФУНКЦИЯ ПАРСИНГА TSV ТАБЛИЦ (ИЗ ПРЕДЫДУЩЕГО ШАГА) ---
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

// --- АЛГОРИТМ УПАКОВКИ ---
async function getOptimalPackaging(username) {
    try {
        const [ordRes, prodRes, boxRes] = await Promise.all([ fetch(TSV_ORDERS), fetch(TSV_PRODUCTS), fetch(TSV_BOXES) ]);
        const orders = parseTSV(await ordRes.text());
        const products = parseTSV(await prodRes.text());
        const boxes = parseTSV(await boxRes.text());

        const cleanUser = username.replace('@', '').trim().toLowerCase();
        
        const userOrders = orders.filter(o => {
            const rowUser = (o['юзернейм'] || '').replace('@', '').trim().toLowerCase();
            return rowUser === cleanUser;
        });

        if (userOrders.length === 0) return { error: "Заказы для этого юзернейма не найдены в таблице." };

        let totalVolume = 0, totalWeight = 0, maxL = 0, maxW = 0, maxH = 0, foundProducts = 0;

        userOrders.forEach(o => {
            const orderItemName = (o['товар (точное название)'] || o['товар'] || o['позиция'] || '').trim().toLowerCase();
            const prod = products.find(p => {
                const pName = (p['товар'] || p['позиция'] || '').trim().toLowerCase();
                return pName === orderItemName && pName !== '';
            });

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

        if (foundProducts === 0 || totalVolume === 0) return { error: "Не удалось определить габариты. Проверьте названия товаров." };

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
                if (boxVol < minBoxVol) {
                    minBoxVol = boxVol;
                    selectedBox = { length: bl, width: bw, height: bh, weight: totalWeight + boxWeight, materialCost: matCost };
                }
            }
        });

        if (!selectedBox) selectedBox = { length: 30, width: 20, height: 15, weight: totalWeight + 150, materialCost: 80 };
        return { success: true, box: selectedBox, itemCount: userOrders.length };

    } catch (e) {
        return { error: "Не удалось прочитать данные таблицы заказов." };
    }
}

// --- НОВЫЙ МЕТОД РАСЧЕТА ДОСТАВКИ ---
app.post('/api/delivery-calc', async (req, res) => {
    const { deliveryPointId, tgUser } = req.body;

    if (!deliveryPointId || !tgUser) return res.status(400).json({ success: false, error: "Выберите ПВЗ на карте и укажите Юзернейм." });

    const packData = await getOptimalPackaging(tgUser);
    if (packData.error) return res.status(400).json({ success: false, error: packData.error });

    const authResult = await getOzonToken();
    if (authResult.error) return res.status(500).json({ success: false, error: `Ответ Ozon Auth: ${authResult.error}` });

    const url = "https://api-delivery.ozon.ru/v1/order/checkout";
    
    // Формируем полезную нагрузку по новой документации
    const payload = {
        recipient: { phone_number: "+79990000000" }, // Технический номер для проверки доступности
        postings: [{
            request_id: 1,
            shipment_method_id: Number(OZON_SHIPMENT_METHOD_ID),
            declared_value: { amount: "100.00", currency_code: "RUB" },
            dimensions: { 
                weight_g: Math.ceil(packData.box.weight), 
                length_mm: Math.ceil(packData.box.length * 10), // Перевод см в мм
                width_mm: Math.ceil(packData.box.width * 10), 
                height_mm: Math.ceil(packData.box.height * 10) 
            }
        }],
        delivery: {
            delivery_point: { delivery_point_id: Number(deliveryPointId) }
        }
    };

    try {
        const ozonRes = await fetch(url, {
            method: "POST", headers: { "Authorization": `Bearer ${authResult.token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (ozonRes.ok) {
            const data = await ozonRes.json();
            // По новой документации ответ лежит в results[0].posting.estimated_delivery_cost.amount
            const ozonTariff = parseFloat(data.results[0]?.posting?.estimated_delivery_cost?.amount) || 0; 
            
            const rawCost = ozonTariff + packData.box.materialCost + 20;
            const finalPrice = Math.ceil(rawCost / 0.92);

            res.json({ success: true, deliveryPrice: finalPrice });
        } else {
            const errText = await ozonRes.text();
            res.status(500).json({ success: false, error: `Ошибка калькулятора: ${errText}` });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Сетевая ошибка расчета." });
    }
});

// ... ОПЛАТЫ МОДУЛЬБАНКА ОСТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ (здесь пропущены для экономии места, оставь их как были) ...

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен. Порт ${PORT}`);
});
