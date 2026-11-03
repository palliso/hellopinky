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

                totalVolume += (
