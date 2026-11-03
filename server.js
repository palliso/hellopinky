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

// --- КЛЮЧИ ОПЛАТЫ МОДУЛЬБАНК ---
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

// Парсер таблиц
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

// Сборка коробки
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
                if (boxVol < minBoxVol) { 
                    minBoxVol = boxVol; 
                    selectedBox = { length: bl, width: bw, height: bh, weight: totalWeight + boxWeight, materialCost: matCost }; 
                }
            }
        });

        if (!selectedBox) selectedBox = { length: 30, width: 20, height: 15, weight: totalWeight + 150, materialCost: 80 };
        return { success: true, box: selectedBox };
    } catch (e) { return { error: "Ошибка чтения таблиц." }; }
}

// ВНУТРЕННИЙ КАЛЬКУЛЯТОР
app.post('/api/delivery-calc', async (req, res) => {
    const { tgUser } = req.body;
    if (!tgUser) return res.status(400).json({ success: false, error: "Укажите Юзернейм." });

    const packData = await getOptimalPackaging(tgUser);
    if (packData.error) return res.status(400).json({ success: false, error: packData.error });

    // СРЕДНЯЯ СТОИМОСТЬ ЛОГИСТИКИ OZON. Можешь поменять эту цифру!
    const BASE_OZON_TARIFF = 350; 
    
    // Считаем твои затраты (Тариф + Коробка + 20р пупырка)
    const rawCost = BASE_OZON_TARIFF + packData.box.materialCost + 20;
    
    // Прибавляем 8% налога
    const finalPrice = Math.ceil(rawCost / 0.92);

    res.json({ 
        success: true, 
        deliveryPrice: finalPrice, 
        boxInfo: `Коробка: ${packData.box.length}x${packData.box.width}x${packData.box.height} см. Общий вес: ${packData.box.weight} г.`
    });
});

// МОДУЛЬБАНК ОСТАЕТСЯ БЕЗ ИЗМЕНЕНИЙ (я скрыла код генерации ссылки для краткости)
app.post('/api/pay', async (req, res) => {
    const { item, amount, email } = req.body;
    // ... твой код Модульбанка ...
    res.json({ success: true, link: 'https://pay.modulbank.ru/' }); 
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер запущен. Порт ${PORT}`);
});
