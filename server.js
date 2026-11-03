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

// --- КЛЮЧИ OZON (ОБЯЗАТЕЛЬНО ВСТАВЬ СВОИ) ---
const OZON_CLIENT_ID = "ТВОЙ_CLIENT_ID";
const OZON_CLIENT_SECRET = "ТВОЙ_CLIENT_SECRET";
const OZON_SHIPMENT_METHOD_ID = 1020005031049340;

// --- КЛЮЧИ ОПЛАТЫ ---
const MODUL_TOKEN = "ZWU1MzQzZTctYmUzNi00YjlkLWI3MGMtNDEzYjM0YWYyNDA1OWMzZDlmMTgtOWNjNi00N2E1LTkwMzktNjI0NzIxODRhMGJi";
const CP_ID = "pk_f36ba0fb530c9daf8fb7b97ec5dee";
const CP_SECRET = "f92c854df15751ca8132d7b2e0b0078a";
const MY_INN = "860231492889";
const REDIRECT_URL = "https://hellopinky.ru";

let ozonToken = null, ozonTokenExpiresAt = 0;
let cachedOzonPoints = [];
let ozonDdosCookie = ""; 

// Обход защиты Ozon
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
    } catch (e) { return { error: e.message }; }
}

async function fetchOzonPoints() {
    console.log("Загружаем базу адресов Ozon...");
    const auth = await getOzonToken();
    if (auth.error) { console.log(`Ошибка токена: ${auth.error}`); return; }
    
    try {
        const listRes = await fetchOzon("https://api-delivery.ozon.ru/v1/delivery-point/list", {
            method: "POST", headers: { "Authorization": `Bearer ${auth.token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ pagination: { limit: 5000 } })
        });
        const listData = await listRes.json();
        if (!listData.delivery_points) return;
        
        const ids = listData.delivery_points.map(p =>
