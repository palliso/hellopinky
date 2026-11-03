process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TSV_ORDERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=0&single=true&output=tsv";
const TSV_PRODUCTS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=538172532&single=true&output=tsv";
const TSV_BOXES = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=1518762544&single=true&output=tsv";

const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340;

let ozonDdosCookie = "";
let cachedOzonPoints = [];
let isBaseLoading = false;

// 1. Обход защиты Ozon
async function fetchOzon(url, options = {}) {
    options.redirect = 'manual'; 
    if (!options.headers) options.headers = {};
    if (ozonDdosCookie) options.headers['Cookie'] = ozonDdosCookie;

    let res = await fetch(url, options);
    if (res.status === 302 || res.status === 307) {
        const setCookie = res.headers.get('set-cookie');
        if (setCookie) {
            ozonDdosCookie = setCookie.split(';')[0]; 
            options.headers['Cookie'] = ozonDdosCookie;
        }
        const loc = res.headers.get('location');
        const redirectUrl = loc.startsWith('http') ? loc : `https://api-delivery.ozon.ru${loc}`;
        res = await fetch(redirectUrl, options);
    }
    return res;
}

// 2. Получение токена
async function getOzonToken() {
    const res = await fetch("https://xapi.ozon.ru/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: OZON_CLIENT_ID,
            client_secret: OZON_CLIENT_SECRET,
            grant_type: "client_credentials",
            scope: ["delivery-api.delivery", "delivery-api.delivery-point", "delivery-api.order", "delivery-api.posting"]
        })
    });
    const data = await res.json();
    return data.access_token;
}

// 3. ФОНОВАЯ ЗАГРУЗКА БАЗЫ (без зависания сервера)
async function loadPvzDatabase() {
    if (isBaseLoading) return;
    isBaseLoading = true;
    console.log("Начинаем фоновую загрузку базы ПВЗ Ozon...");
    
    try {
        const token = await getOzonToken();
        if (!token) throw new Error("Не удалось получить токен");

        let allIds = [];
        let offset = 0;
        const limit = 1000;

        // Листаем страницы по 1000 штук
        while (true) {
            const listRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/list", {
                method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ pagination: { limit, offset } })
            });
            const listData = await listRes.json();
            if (listData.error || !listData.delivery_points || listData.delivery_points.length === 0) break;
            
            allIds.push(...listData.delivery_points.map(p => p.delivery_point_id));
            offset += limit;
        }

        console.log(`Получено ${allIds.length} ID. Загружаем адреса...`);
        let points = [];
        
        // Качаем информацию порциями по 500
        for (let i = 0; i < allIds.length; i += 500) {
            const chunk = allIds.slice(i, i + 500);
            const infoRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/info", {
                method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ delivery_point_ids: chunk })
            });
            const infoData = await infoRes.json();
            
            if (infoData.delivery_points) {
                points.push(...infoData.delivery_points.filter(p => p.is_active).map(p => ({
                    id: p.delivery_point_id,
                    address: p.full_address
                })));
            }
            await new Promise(r => setTimeout(r, 500)); // Задержка от блокировок
        }
        
        cachedOzonPoints = points;
        console.log(`✅ База ПВЗ успешно загружена в память: ${cachedOzonPoints.length} пунктов.`);
    } catch (e) {
        console.log(`❌ Ошибка фоновой загрузки ПВЗ: ${e.message}`);
    } finally {
        isBaseLoading = false;
    }
}
// Запускаем загрузку базы сразу при старте, не дожидаясь её окончания
loadPvzDatabase();
// Раз в 12 часов обновляем базу в фоне
setInterval(loadPvzDatabase, 12 * 60 * 60 * 1000);

// 4. Логика Google Таблиц
function parseTSV(text) {
    const lines = text.replace(/\r/g, '').trim().split('\n');
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
        if (userOrders.length === 0) return { error: "Заказы для этого юзернейма не найдены." };

        let totalVolume = 0, totalWeight = 0, maxL = 0, maxW = 0, maxH = 0;
        userOrders.forEach(o => {
            const orderItemName = (o['товар (точное название)'] || o['товар'] || '').trim().toLowerCase();
            const prod = products.find(p => (p['товар'] || '').trim().toLowerCase() === orderItemName);
            if (prod) {
                const qty = parseInt(o['кол-во'] || '1') || 1;
                const l = parseFloat((prod['длина (см)'] || '0').replace(',', '.')) || 0;
                const w = parseFloat((prod['ширина (см)'] || '0').replace(',', '.')) || 0;
                const h = parseFloat((prod['высота (см)'] || '0').replace(',', '.')) || 0;
                const weight = parseFloat((prod['вес (г)'] || '0').replace(',', '.')) || 0;
                totalVolume += (l * w * h) * qty;
                totalWeight += weight * qty;
                const dims = [l, w, h].sort((a,b) => b - a);
                if (dims[0] > maxL) maxL = dims[0];
                if (dims[1] > maxW) maxW = dims[1];
                if (dims[2] > maxH) maxH = dims[2];
            }
        });

        if (totalVolume === 0) return { error: "Не удалось определить габариты." };

        let selectedBox = null, minBoxVol = Infinity;
        boxes.forEach(b => {
            const bl = parseFloat((b['длина (см)'] || '0').replace(',', '.'));
            const bw = parseFloat((b['ширина (см)'] || '0').replace(',', '.'));
            const bh = parseFloat((b['высота (см)'] || '0').replace(',', '.'));
            const boxWeight = parseFloat((b['вес пустой (г)'] || '0').replace(',', '.'));
            const matCost = parseFloat((b['стоимость материалов (₽)'] || '0').replace(',', '.'));
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
        return { success: true, box: selectedBox };
    } catch (e) { return { error: "Ошибка чтения таблиц Google." }; }
}

// 5. Маршрут подсказок ПВЗ
app.get('/api/pvz-suggest', (req, res) => {
    if (cachedOzonPoints.length === 0) {
        return res.json({ points: [{ id: null, address: "База ПВЗ загружается, попробуйте через минуту..." }] });
    }
    
    const q = (req.query.q || '').toLowerCase().trim();
    if (q.length < 3) return res.json({ points: [] });

    const searchTerms = q.split(/\s+/);
    const results = cachedOzonPoints.filter(p => {
        const addrNorm = p.address.toLowerCase();
        return searchTerms.every(term => addrNorm.includes(term));
    }).slice(0, 10);

    res.json({ points: results });
});

// 6. Расчет доставки
// 6. Расчет доставки (умный поиск ПВЗ)
app.post('/api/delivery-calc', async (req, res) => {
    let { pvzId, targetAddress, tgUser, phone } = req.body;
    if (!tgUser || (!pvzId && !targetAddress)) {
        return res.status(400).json({ success: false, error: "Укажите адрес ПВЗ и Юзернейм." });
    }

    // Если клиент не выбрал из списка, а просто нажал кнопку с текстом — ищем ПВЗ сами
    let finalAddressString = "Неизвестный ПВЗ";
    if (!pvzId && targetAddress) {
        if (cachedOzonPoints.length === 0) {
            return res.status(500).json({ success: false, error: "База ПВЗ еще загружается, подождите 1 минуту." });
        }
        const searchTerms = targetAddress.toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
        const foundPvz = cachedOzonPoints.find(p => {
            const addrNorm = p.address.toLowerCase();
            return searchTerms.every(term => addrNorm.includes(term));
        });
        
        if (!foundPvz) return res.status(400).json({ success: false, error: "ПВЗ не найден. Уточните адрес." });
        pvzId = foundPvz.id;
        finalAddressString = foundPvz.address;
    } else if (pvzId) {
        // Если выбрали из списка, просто красивое название для чека
        const foundPvz = cachedOzonPoints.find(p => p.id == pvzId);
        if (foundPvz) finalAddressString = foundPvz.address;
    }

    const packData = await getOptimalPackaging(tgUser);
    if (packData.error) return res.status(400).json({ success: false, error: packData.error });

    const token = await getOzonToken();
    if (!token) return res.status(500).json({ success: false, error: "Ошибка токена Ozon." });

    const url = "https://api-delivery.ozon.ru/v1/order/checkout";
    const payload = {
        recipient: { phone_number: phone || "+79990000000" },
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
        delivery: { delivery_point: { delivery_point_id: Number(pvzId) } }
    };

    try {
        const ozonRes = await fetchOzon(url, {
            method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (ozonRes.ok) {
            const data = await ozonRes.json();
            const ozonTariff = parseFloat(data.results[0]?.posting?.estimated_delivery_cost?.amount) || 0; 
            const finalPrice = Math.ceil((ozonTariff + packData.box.materialCost + 20) / 0.92);
            res.json({ success: true, deliveryPrice: finalPrice, foundAddress: finalAddressString });
        } else {
            res.status(500).json({ success: false, error: `ПВЗ недоступен для расчета.` });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Сетевая ошибка расчета." });
    }
});

app.post('/api/pay', async (req, res) => {
    // ВСТАВЬ ТУТ СВОЙ КОД ОПЛАТЫ МОДУЛЬБАНКА
    res.json({ success: true, link: 'https://pay.modulbank.ru/' }); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Сервер запущен на порту ${PORT}`); 
});
