// Отключаем проверку SSL-сертификатов для API Модульбанка
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Раздаем статические файлы (HTML, CSS, JS) из папки public
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. НАСТРОЙКИ ОПЛАТЫ И ИНТЕГРАЦИЙ
// ==========================================
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

// Конфигурация торговых точек для разных вкладок
const RETAIL_POINTS = {
    main: "ВСТАВЬ_СЮДА_ID_ТОЧКИ_ОСНОВНЫХ_ОПЛАТ", // <--- ВСТАВЬ СВОЙ ID ДЛЯ ОСНОВНЫХ ОПЛАТ
    preorder: "a828d71d-f5b5-4959-a605-d9a0192d8416"
};

// Ссылка на Google Таблицы (Web App)
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbzry07Mbx3R17eJh5qhbbiSjqx7Wl4Clcbuar2xsry9A3iRtaN4evvS5SJxXM0g9pAkvw/exec";

// ==========================================
// 2. НАСТРОЙКИ OZON API
// ==========================================
const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340;
let ozonDdosCookie = "";

const CACHE_DIR = '/data';
const CACHE_FILE = fs.existsSync(CACHE_DIR) 
    ? path.join(CACHE_DIR, 'pvz_cache.json') 
    : path.join(__dirname, 'pvz_cache.json');

let cachedOzonPoints = [];
let isBaseLoading = false;

// Состояние оплат и логирование
let state = {
    waiting: {},
    history: []
};

function addLog(msg) {
    const now = new Date().toLocaleTimeString('ru-RU');
    state.history.unshift(`[${now}] ${msg}`);
    if (state.history.length > 30) state.history.pop();
    console.log(`[LOG] ${msg}`);
}

// ==========================================
// 3. БАЗОВЫЕ ФУНКЦИИ И СКАЧИВАНИЕ ПВЗ
// ==========================================
if (fs.existsSync(CACHE_FILE)) {
    try {
        cachedOzonPoints = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
        if (cachedOzonPoints.length === 0 || (cachedOzonPoints[0] && cachedOzonPoints[0].address === "Адрес уточняется")) {
            console.log(`🗑️ Найден битый или пустой кэш. Удаляем и перекачиваем...`);
            cachedOzonPoints = [];
            fs.unlinkSync(CACHE_FILE);
        } else {
            console.log(`✅ Кэш ПВЗ успешно загружен. Точек: ${cachedOzonPoints.length}`);
        }
    } catch (e) {
        console.log(`⚠️ Ошибка чтения файла кэша.`);
    }
}

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
    } catch (e) { return null; }
}

async function loadPvzDatabase() {
    if (isBaseLoading) return;
    if (cachedOzonPoints.length > 5000) return;

    isBaseLoading = true;
    try {
        const token = await getOzonToken();
        if (!token) { 
            console.log("❌ Ошибка: не удалось получить токен Ozon.");
            isBaseLoading = false; 
            return; 
        }

        let allPoints = [];
        let cursor = "";
        const limit = 100;
        const headers = { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" };

        let hasMore = true;
        let failCount = 0;

        console.log("⏳ Начинаем выгрузку ПВЗ и расшифровку адресов...");

        while (hasMore && failCount < 5) {
            try {
                const bodyPayload = { pagination: { limit: limit } };
                if (cursor) bodyPayload.pagination.cursor = cursor;

                const listRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/list", {
                    method: "POST", headers, body: JSON.stringify(bodyPayload)
                });
                
                if (!listRes.ok) {
                    failCount++;
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                const listData = await listRes.json();
                if (!listData.delivery_points || listData.delivery_points.length === 0) break;
                
                const chunkIds = [];
                for (const dp of listData.delivery_points) {
                    const rawId = dp.delivery_point || dp.delivery_point_id || dp.id;
                    const numId = Number(rawId);
                    if (!isNaN(numId)) {
                        chunkIds.push(numId);
                    }
                }

                if (chunkIds.length > 0) {
                    const infoRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/info", {
                        method: "POST", headers, body: JSON.stringify({ delivery_point_ids: chunkIds })
                    });

                    if (infoRes.ok) {
                        const infoData = await infoRes.json();
                        if (infoData.delivery_points) {
                            for (const p of infoData.delivery_points) {
                                const addrStr = p.full_address || p.name;
                                if (addrStr) {
                                    allPoints.push({
                                        id: p.delivery_point_id || p.id,
                                        address: addrStr
                                    });
                                }
                            }
                        }
                    }
                }

                if (listData.next_cursor) { 
                    cursor = listData.next_cursor; 
                    failCount = 0; 
                } else { 
                    hasMore = false; 
                }
                
                await new Promise(r => setTimeout(r, 1500));
            } catch (err) { 
                failCount++; 
                await new Promise(r => setTimeout(r, 5000)); 
            }
        }

        if (allPoints.length > 0) {
            cachedOzonPoints = allPoints;
            fs.writeFileSync(CACHE_FILE, JSON.stringify(cachedOzonPoints));
            console.log(`✅ ИТОГ: База полностью загружена! Сохранено ПВЗ: ${cachedOzonPoints.length}`);
        }
    } catch (e) {
        console.log(`❌ Критическая ошибка: ${e.message}`);
    } finally { 
        isBaseLoading = false; 
    }
}

// Запускаем робот скачивания базы после старта сервера
setTimeout(() => { loadPvzDatabase(); }, 2000);

// ==========================================
// 4. ПАРСЕР ТАБЛИЦ И РАСЧЕТ УПАКОВКИ
// ==========================================
const TSV_ORDERS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=0&single=true&output=tsv";
const TSV_PRODUCTS = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=538172532&single=true&output=tsv";
const TSV_BOXES = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQwoM70qCr98icYJEUamI8Lo5qr8jBAE27oOxaBKRaeBL7NUgagCe6MMlQy667OaxbJh3r1feLsZGMT/pub?gid=1518762544&single=true&output=tsv";

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
        if (!username || typeof username !== 'string') {
            return { error: "Отсутствует юзернейм для поиска." };
        }

        const [ordRes, prodRes, boxRes] = await Promise.all([ fetch(TSV_ORDERS), fetch(TSV_PRODUCTS), fetch(TSV_BOXES) ]);
        const orders = parseTSV(await ordRes.text());
        const products = parseTSV(await prodRes.text());
        const boxes = parseTSV(await boxRes.text());

        const cleanUser = username.replace('@', '').trim().toLowerCase();
        const userOrders = orders.filter(o => (o['юзернейм'] || '').replace('@', '').trim().toLowerCase() === cleanUser);
        
        if (userOrders.length === 0) return { error: "Заказы для этого юзернейма не найдены." };

        let totalVolume = 0, totalWeight = 0, maxL = 0, maxW = 0, maxH = 0;
        let itemNames = []; 

        userOrders.forEach(o => {
            const orderItemName = (o['товар (точное название)'] || o['товар'] || '').trim().toLowerCase();
            const qty = parseInt(o['кол-во'] || '1') || 1;
            
            if (orderItemName) itemNames.push(`${orderItemName} (${qty} шт.)`); 

            const prod = products.find(p => (p['товар'] || '').trim().toLowerCase() === orderItemName);
            if (prod) {
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
        return { success: true, box: selectedBox, itemsStr: itemNames.join(', ') }; 
    } catch (e) { return { error: "Внутренняя ошибка таблиц." }; }
}

// ==========================================
// 5. СОЗДАНИЕ ЗАКАЗА В OZON (ПОСЛЕ ОПЛАТЫ ИЛИ НАПРЯМУЮ)
// ==========================================
async function createOzonOrder(orderInfo) {
    if (!orderInfo.tgUser) {
        addLog(`❌ Ошибка: Ozon заказ отменен, так как tgUser пустой.`);
        return;
    }

    addLog(`📦 Начинаем создание заказа Ozon для ${orderInfo.tgUser}...`);
    const packData = await getOptimalPackaging(orderInfo.tgUser);
    if (packData.error) { addLog(`❌ Ошибка упаковки: ${packData.error}`); return; }

    const foundPvz = cachedOzonPoints.find(p => p.address === orderInfo.pvzAddress);
    if (!foundPvz) { addLog(`❌ ПВЗ не найден в кэше.`); return; }

    const token = await getOzonToken();
    
    let declaredValue = "100.00"; 
    if (orderInfo.needInsurance && parseFloat(orderInfo.insAmount) > 0) {
        declaredValue = parseFloat(orderInfo.insAmount).toFixed(2);
    }

    const payload = {
        order_external_id: "hp-" + Date.now(), 
        recipient: { 
            phone_number: orderInfo.phone, 
            full_name: orderInfo.tgUser 
        }, 
        postings: [{
            request_id: 1,
            shipment_method_id: Number(OZON_SHIPMENT_METHOD_ID),
            description: packData.itemsStr.substring(0, 250), 
            declared_value: { amount: String(declaredValue), currency_code: "RUB" }, 
            dimensions: { 
                weight_g: Math.ceil(packData.box.weight), 
                length_mm: Math.ceil(packData.box.length * 10),
                width_mm: Math.ceil(packData.box.width * 10), 
                height_mm: Math.ceil(packData.box.height * 10) 
            }
        }],
        delivery: { delivery_point: { delivery_point_id: Number(foundPvz.id) } } 
    };

    try {
        const res = await fetchOzon("https://api-delivery.ozon.ru/v1/order/create", { 
            method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        const data = await res.json();
        if (data.postings && data.postings[0]) {
            const postingNum = data.postings[0].posting_number;
            addLog(`✅ Ozon заказ создан! Трек: ${postingNum}`);
            
            // Запись в Google Таблицу через Web App
            await fetch(GOOGLE_SHEET_URL, {
                method: 'POST',
                body: JSON.stringify({
                    postingNumber: postingNum,
                    tgUser: orderInfo.tgUser,
                    items: packData.itemsStr,
                    box: `${packData.box.length}x${packData.box.width}x${packData.box.height}`
                })
            }).catch(e => addLog("⚠️ Ошибка отправки в гугл таблицу"));
        } else {
            addLog(`❌ Ошибка Ozon: ${JSON.stringify(data)}`);
        }
    } catch (e) {
        addLog(`❌ Ошибка сети при создании Ozon заказа: ${e.message}`);
    }
}

// ==========================================
// 6. ОПЛАТА И СТАТУСЫ (МОДУЛЬБАНК & CLOUDKASSIR)
// ==========================================
async function createDynamicQr(amount, description, retailPointId) {
    const url = "https://api.modulbank.ru/v1/sbp/qr-codes/dynamic";
    const headers = { "Authorization": `Bearer ${MODUL_TOKEN}`, "Content-Type": "application/json" };
    const payload = { retailPointId: retailPointId, sum: Number(amount), extraInfo: description.substring(0, 140), redirectUrl: REDIRECT_URL };
    try {
        const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
        if (res.ok) { const data = await res.json(); return { link: data.payload, qrcId: data.qrcId }; }
    } catch (e) { }
    return { link: null, qrcId: null };
}

async function sendReceipt(amount, email, itemName) {
    const auth = Buffer.from(`${CP_ID}:${CP_SECRET}`).toString('base64');
    const payload = { Inn: MY_INN, Type: "Income", CustomerReceipt: { Items: [{ label: itemName, price: Number(amount), quantity: 1, amount: Number(amount), vat: null, method: 1, object: 1 }], taxationSystem: 1, email: email } };
    try {
        const res = await fetch("https://api.cloudpayments.ru/kkt/receipt", { method: "POST", headers: { "Authorization": `Basic ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        return res.ok;
    } catch (e) { return false; }
}

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
                    if (success) {
                        delete state.waiting[qid];
                        addLog(`✅ Оплата получена, чек для ${o.email} успешно отправлен!`);
                        
                        // Создаем отправление Ozon только после успешной оплаты
                        if (o.paymentType === 'delivery') {
                            createOzonOrder(o);
                        }
                    }
                }
            }
        } catch (e) {}
    }
}, 10000);

// ==========================================
// 7. API МАРШРУТЫ И ENDPOINTS
// ==========================================
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
    let { pvzId, targetAddress, tgUser, phone, needInsurance, insAmount } = req.body;
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
        
        if (!foundPvz) return res.status(400).json({ success: false, error: "ПВЗ не найден." });
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

    let declaredValue = "100.00"; 
    if (needInsurance && parseFloat(insAmount) > 0) {
        declaredValue = parseFloat(insAmount).toFixed(2);
    }

    const url = "https://api-delivery.ozon.ru/v1/order/checkout";
    const payload = {
        recipient: { phone_number: phone || "+79990000000" }, 
        postings: [{
            request_id: 1,
            shipment_method_id: Number(OZON_SHIPMENT_METHOD_ID),
            declared_value: { amount: String(declaredValue), currency_code: "RUB" }, 
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
            const ozonInsurance = parseFloat(data.results[0]?.posting?.estimated_insurance_cost?.amount) || 0; 
            
            const finalPrice = Math.ceil((ozonTariff + ozonInsurance + packData.box.materialCost + 20) / 0.92);
            
            res.json({ 
                success: true, 
                deliveryPrice: finalPrice, 
                foundAddress: finalAddressString, 
                itemsStr: packData.itemsStr 
            });
        } else {
            res.status(500).json({ success: false, error: `ПВЗ недоступен для расчета.` });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Сетевая ошибка расчета." });
    }
});

app.post('/api/pay', async (req, res) => {
    const { item, amount, email, paymentType, tgUser, phone, pvzAddress, needInsurance, insAmount } = req.body;
    
    if (!item || !amount || amount <= 0 || !email) {
        return res.status(400).json({ success: false, error: "Заполните все поля." });
    }

    // Возвращена реальная оплата через Модульбанк для всех типов платежей
    const targetPointId = RETAIL_POINTS[paymentType] || RETAIL_POINTS.main;
    const { link, qrcId } = await createDynamicQr(amount, item, targetPointId);
    
    if (link && qrcId) {
        state.waiting[qrcId] = { 
            email, item, amount, paymentType, 
            tgUser, phone, pvzAddress, needInsurance, insAmount, 
            created_at: Date.now() 
        };
        addLog(`🌸 СБП QR (${paymentType || 'main'}) для ${email}`);
        return res.json({ success: true, link });
    }
    res.status(500).json({ success: false, error: "Ошибка генерации QR в Модульбанке. Проверьте логи сервера." });
});

app.get('/api/logs', (req, res) => {
    res.json({ waiting: Object.keys(state.waiting).length, history: state.history });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { 
    console.log(`🚀 Сервер запущен на порту ${PORT}`); 
});
