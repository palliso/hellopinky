const fetch = require('node-fetch');
const fs = require('fs');

const OZON_CLIENT_ID = "f0f0d638-7c3b-4f17-a5a1-d44b63bc8b1e";
const OZON_CLIENT_SECRET = "a5a1d29c05115394f19204c5dcfd507a86f227fe193feb903d07946bdc6e1579";

async function download() {
    console.log("1. Получаем токен...");
    const tokenRes = await fetch("https://xapi.ozon.ru/oauth/token", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: OZON_CLIENT_ID,
            client_secret: OZON_CLIENT_SECRET,
            grant_type: "client_credentials"
        })
    });
    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    console.log("2. Запрашиваем список ПВЗ...");
    const listRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/list", {
        method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ pagination: { limit: 5000 } })
    });
    const listData = await listRes.json();
    const ids = listData.delivery_points.map(p => p.delivery_point_id);

    console.log(`Найдено ${ids.length} ПВЗ. Скачиваем адреса...`);
    const infoRes = await fetch("https://api-delivery.ozon.ru/v1/delivery-point/info", {
        method: "POST", headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ delivery_point_ids: ids })
    });
    const infoData = await infoRes.json();

    const points = infoData.delivery_points.filter(p => p.is_active).map(p => ({
        id: p.delivery_point_id,
        address: p.full_address
    }));

    fs.writeFileSync('pvz.json', JSON.stringify(points, null, 2));
    console.log("✅ Готово! Файл pvz.json успешно создан в этой же папке.");
}
download();
