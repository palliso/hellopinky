process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CACHE_FILE = path.join(__dirname, 'pvz_cache.json');
let cachedOzonPoints = [];
let isBaseLoading = false;

// Мгновенная загрузка кэша при старте
if (fs.existsSync(CACHE_FILE)) {
    try {
        cachedOzonPoints = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        console.log(`✅ Кэш ПВЗ загружен. Точек в базе: ${cachedOzonPoints.length}`);
    } catch (e) {
        console.log(`⚠️ Ошибка чтения кэша, будет сформирован новый.`);
    }
}

const TSV_ORDERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=0&single=true&output=tsv";
const TSV_PRODUCTS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=538172532&single=true&output=tsv";
const TSV_BOXES = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=1518762544&single=true&output=tsv";

const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340;

let ozonDdosCookie = "";

async function fetchOzon(url, options = {}) {
    options.redirect = 'manual'; 
    if (!options.headers) options.headers = {};
    options.headers['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
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

async function getOzonToken() {
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
        const data = await res.json();
        return data.access_token;
    } catch (e) {
        return null;
    }
}

// Фоновая загрузка по официальному курсору Ozon[cite: 53]
async function loadPvzDatabase() {
    if (isBaseLoading) return;
    
    // Если база уже собрана (больше 1000 точек), не дергаем API лишний раз
    if (cachedOzonPoints.length > 1000) {
        console.log(`✨ База актуальна (${cachedOzonPoints.length} точек). Пропускаем скачивание.`);
        return;
    }

    isBaseLoading = true;
    console.log(`⏳ Старт фоновой выгрузки ПВЗ через Ozon Delivery API...`);
    
    try {
        const token = await getOzonToken();
        if (!token) {
            isBaseLoading = false;
            return;
        }

        let allPoints = [...cachedOzonPoints];
        let allIds = new Set(allPoints.map(p => p.id));
        let cursor = null;
        const limit = 100;
        const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

        let hasMore = true;
        let failCount = 0;

        while (hasMore && failCount < 5) {
            try {
                const bodyPayload = {
                    pagination: {
                        limit: limit,
                        ...(cursor ? { cursor: cursor } : {})
                    }
                };

                const listRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/list", {
                    method: "POST", headers, body: JSON.stringify(bodyPayload)
                });
                
                if (!listRes.ok) {
                    failCount++;
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }

                const listData = await listRes.json();
                
                if (!listData.delivery_points || listData.delivery_points.length === 0) {
                    break;
                }
                
                let addedCount = 0;
                for (const p of listData.delivery_points) {
                    const pointId = p.delivery_point_id || p.id;
                    const pointAddr = p.full_address || p.address;
                    
                    if (pointId && !allIds.has(pointId)) {
                        allIds.add(pointId);
                        allPoints.push({
                            id: pointId,
                            address: pointAddr || "Адрес уточняется"
                        });
                        addedCount++;
                    }
                }

                fs.writeFileSync(CACHE_FILE, JSON.stringify(allPoints));
                if (addedCount > 0) {
                    console.log(`💾 Добавлено новых: ${addedCount}. 📊 Всего адресов в базе: ${allPoints.length}`);
                }

                if (listData.next_cursor) {
                    cursor = listData.next_cursor;
                    failCount = 0;
                } else {
                    hasMore = false;
                }

                await new Promise(r => setTimeout(r, 1500)); // Безопасная пауза
            } catch (err) {
                failCount++;
                await new Promise(r => setTimeout(r, 4000));
            }
        }

        cachedOzonPoints = allPoints;
        console.log(`✅ ИТОГ: База ПВЗ готова. Всего точек: ${cachedOzonPoints.length}`);
    } catch (e) {
        console.log(`❌ Ошибка загрузки базы: ${e.message}`);
    } finally {
        isBaseLoading = false;
    }
}

setTimeout(() => { loadPvzDatabase(); }, 4000);
setInterval(loadPvzDatabase, 7 * 24 * 60 * 60 * 1000);

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
            const bDims = [bl, bw, bh].sort((a,b) => a - b);

            if (boxVol >= totalVolume && bDims[0] <= bl && bDims[1] <= bw && bDims[2] <= bh) {
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

app.get('/api/pvz-suggest', (req, res) => {
    const q = (req.query.q || '').toLowerCase().trim();
    if (q.length < 3 || cachedOzonPoints.length === 0) return res.json({ points: [] });

    const searchTerms = q.split(/\s+/);
    const results = cachedOzonPoints.filter(p => {
        const addrNorm = p.address.toLowerCase();
        return searchTerms.every(term => addrNorm.includes(term));
    }).slice(0, 10);

    res.json({ points: results });
});

app.post('/api/delivery-calc', async (req, res) => {
    let { pvzId, targetAddress, tgUser, phone } = req.body;
    if (!tgUser || (!pvzId && !targetAddress)) {
        return res.status(400).json({ success: false, error: "Укажите адрес ПВЗ и Юзернейм." });
    }

    let finalAddressString = "Неизвестный ПВЗ";
    if (!pvzId && targetAddress) {
        const searchTerms = targetAddress.toLowerCase().match(/[a-zа-яё0-9]+/g) || [];
        const foundPvz = cachedOzonPoints.find(p => {
            const addrNorm = p.address.toLowerCase();
            return searchTerms.every(term => addrNorm.includes(term));
        });
        
        if (!foundPvz) return res.status(400).json({ success: false, error: "ПВЗ не найден. Уточните адрес." });
        pvzId = foundPvz.id;
        finalAddressString = foundPvz.address;
    } else if (pvzId) {
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
        const resCheck = await fetchOzon(url, {
            method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        if (resCheck.ok) {
            const data = await resCheck.json();
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
    res.json({ success: true, link: 'https://pay.modulbank.ru/' }); 
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Сервер запущен на порту ${PORT}`); 
});
