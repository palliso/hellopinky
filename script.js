const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/ВАШ_ДЛИННЫЙ_КОД/exec';

let items = JSON.parse(localStorage.getItem('hp_items')) || [];
let cart = JSON.parse(localStorage.getItem('hp_cart')) || [];
let orders = JSON.parse(localStorage.getItem('hp_orders')) || [];

let activeOrderId = null;
const CANCEL_TIMEOUT_MS = 10 * 60 * 1000;

function seedData() {
    if (items.length === 0) {
        items = [
            { id: 1, type: 'instock', name: 'Протекторы My Little Pony (100 шт)', desc: 'Плотные голографические протекторы для SSR карточек.', price: 350, stock: 15, img: 'https://images.unsplash.com/photo-1618331835717-801e976710b2?auto=format&fit=crop&q=80&w=400' },
            { id: 2, type: 'preorder', name: 'Blind Box: Midnight Nursery Rhymes', desc: 'Оригинальный слепой бокс с фигурками BJD.', price: 1800, stock: 5, img: 'https://images.unsplash.com/photo-1593452586716-4171a82f8016?auto=format&fit=crop&q=80&w=400' }
        ];
        saveData();
    }
}

function saveData() {
    localStorage.setItem('hp_items', JSON.stringify(items));
    localStorage.setItem('hp_cart', JSON.stringify(cart));
    localStorage.setItem('hp_orders', JSON.stringify(orders));
}

function checkExpiredOrders() {
    let changed = false;
    const now = Date.now();
    orders.forEach(order => {
        if (order.status === 'Ожидает оплаты' && (now - order.createdAt > CANCEL_TIMEOUT_MS)) {
            order.status = 'Отменен';
            order.items.forEach(orderedItem => {
                const item = items.find(i => i.id === orderedItem.id);
                if (item) item.stock += orderedItem.quantity;
            });
            changed = true;
        }
    });
    if (changed) { saveData(); renderStorefront(); renderAdminOrders(); }
}
setInterval(checkExpiredOrders, 30000);

function toggleAdmin(show) {
    document.getElementById('storefront').style.display = show ? 'none' : 'block';
    document.getElementById('adminPanel').style.display = show ? 'block' : 'none';
    if(show) { renderAdminItems(); renderAdminOrders(); } else { renderStorefront(); }
}

function renderStorefront() {
    const inStockGrid = document.getElementById('inStockGrid');
    const preOrderGrid = document.getElementById('preOrderGrid');
    inStockGrid.innerHTML = ''; preOrderGrid.innerHTML = '';

    items.forEach(item => {
        const isOutOfStock = item.stock <= 0;
        const badgeClass = item.type === 'instock' ? 'badge in-stock' : 'badge pre-order';
        const badgeText = item.type === 'instock' ? 'В НАЛИЧИИ' : 'ПРЕДЗАКАЗ';
        
        const card = `
            <div class="card">
                <img src="${item.img}" alt="${item.name}" class="card-img">
                <div class="card-content">
                    <span class="${badgeClass}">${badgeText}</span>
                    <h3 class="card-title">${item.name}</h3>
                    <p class="card-desc">${item.desc}</p>
                    <p class="card-stock ${isOutOfStock ? 'low' : ''}">Осталось: ${item.stock} шт.</p>
                    <div class="card-footer">
                        <span class="price">${item.price} ₽</span>
                        <button class="btn" onclick="addToCart(${item.id})" ${isOutOfStock ? 'disabled' : ''}>${isOutOfStock ? 'Нет в наличии' : 'В корзину'}</button>
                    </div>
                </div>
            </div>
        `;
        if (item.type === 'instock') inStockGrid.innerHTML += card;
        else preOrderGrid.innerHTML += card;
    });
    
    updateCartCount();
}

function addToCart(itemId) {
    const item = items.find(i => i.id === itemId);
    if (!item || item.stock <= 0) return;

    item.stock -= 1;

    const existing = cart.find(c => c.id === itemId);
    if (existing) {
        existing.quantity += 1;
    } else {
        cart.push({ id: item.id, name: item.name, price: item.price, quantity: 1, type: item.type });
    }
    saveData();
    renderStorefront();
}

function removeFromCart(itemId) {
    const cartItem = cart.find(c => c.id === itemId);
    if (!cartItem) return;

    const item = items.find(i => i.id === itemId);
    if (item) item.stock += cartItem.quantity;

    cart = cart.filter(c => c.id !== itemId);
    saveData();
    renderStorefront();
    renderCartModal();
}

function updateCartCount() {
    const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
    document.getElementById('cartCount').innerText = totalCount;
}

function openCartModal() {
    renderCartModal();
    document.getElementById('cartModal').style.display = 'flex';
}

function renderCartModal() {
    const container = document.getElementById('cartItemsContainer');
    container.innerHTML = '';

    if (cart.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:var(--text-light); padding:1rem;">Корзина пуста</p>';
        document.getElementById('cartTotalPrice').innerText = '0 ₽';
        document.getElementById('checkoutBtn').style.display = 'none';
        return;
    }

    document.getElementById('checkoutBtn').style.display = 'block';
    let totalPrice = 0;

    cart.forEach(item => {
        totalPrice += item.price * item.quantity;
        container.innerHTML += `
            <div class="cart-item-row">
                <div>
                    <b>${item.name}</b><br>
                    <small>${item.quantity} шт. × ${item.price} ₽</small>
                </div>
                <div style="display:flex; align-items:center; gap:10px;">
                    <span><b>${item.price * item.quantity} ₽</b></span>
                    <button class="delete-btn" onclick="removeFromCart(${item.id})">✕</button>
                </div>
            </div>
        `;
    });

    document.getElementById('cartTotalPrice').innerText = totalPrice + ' ₽';
}

function closeModals() {
    document.getElementById('cartModal').style.display = 'none';
    document.getElementById('paymentModal').style.display = 'none';
}

document.getElementById('checkoutForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (cart.length === 0) return;

    const tg = document.getElementById('customerTg').value;
    const email = document.getElementById('customerEmail').value;
    const totalPrice = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    
    const orderId = 'ORD-' + Math.floor(Math.random() * 10000);
    const orderItemsSummary = cart.map(i => `${i.name} (x${i.quantity})`).join(', ');

    const newOrder = {
        id: orderId,
        items: [...cart],
        summary: orderItemsSummary,
        total: totalPrice,
        contact: `${tg} | ${email}`,
        status: 'Ожидает оплаты',
        date: new Date().toLocaleDateString('ru-RU'),
        createdAt: Date.now()
    };

    orders.unshift(newOrder);
    cart = [];
    saveData();
    renderStorefront();

    activeOrderId = orderId;

    document.getElementById('ymSum').value = totalPrice;
    document.getElementById('ymTargets').value = `Заказ ${orderId}: ${orderItemsSummary}`;
    document.getElementById('ymLabel').value = orderId;
    document.getElementById('paymentAmountDisplay').innerText = totalPrice + ' ₽';

    document.getElementById('cartModal').style.display = 'none';
    document.getElementById('paymentModal').style.display = 'flex';
});

function handlePaymentRedirect() {
    const order = orders.find(o => o.id === activeOrderId);
    if(order) {
        order.status = 'Оплачено';
        saveData();
        sendToGoogleSheets(order);
    }
}

function manualConfirmPayment(orderId) {
    const order = orders.find(o => o.id === orderId);
    if (order) {
        order.status = 'Оплачено';
        saveData();
        sendToGoogleSheets(order);
        renderAdminOrders();
    }
}

function sendToGoogleSheets(orderData) {
    if(GOOGLE_APPS_SCRIPT_URL.includes('ВАШ_ДЛИННЫЙ_КОД')) return;
    
    const payload = {
        id: orderData.id,
        type: 'Заказ с сайта',
        item: orderData.summary,
        price: orderData.total,
        contact: orderData.contact,
        status: orderData.status,
        date: orderData.date
    };

    fetch(GOOGLE_APPS_SCRIPT_URL, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).catch(console.error);
}

document.getElementById('addItemForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const newItem = {
        id: Date.now(),
        type: document.getElementById('itemType').value,
        name: document.getElementById('itemName').value,
        desc: document.getElementById('itemDesc').value,
        price: parseFloat(document.getElementById('itemPrice').value),
        stock: parseInt(document.getElementById('itemStock').value),
        img: document.getElementById('itemImg').value
    };
    items.push(newItem);
    saveData();
    e.target.reset();
    renderAdminItems();
    renderStorefront();
});

function renderAdminItems() {
    const tbody = document.getElementById('adminItemsList');
    tbody.innerHTML = '';
    items.forEach(item => {
        tbody.innerHTML += `
            <tr>
                <td>${item.name}</td>
                <td>${item.type === 'instock' ? 'В наличии' : 'Предзаказ'}</td>
                <td>${item.price} ₽</td>
                <td>${item.stock} шт.</td>
                <td><button class="delete-btn" onclick="deleteItem(${item.id})">Удалить</button></td>
            </tr>
        `;
    });
}

function renderAdminOrders() {
    const tbody = document.getElementById('adminOrdersList');
    tbody.innerHTML = '';
    
    if (orders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-light);">Заказов пока нет</td></tr>';
        return;
    }

    orders.forEach(order => {
        const statusClass = order.status === 'Оплачено' ? 'status-paid' : 'status-pending';
        const actionBtn = order.status === 'Ожидает оплаты' 
            ? `<button style="padding:4px 8px; font-size:12px; cursor:pointer; background:var(--success); border:none; border-radius:4px;" onclick="manualConfirmPayment('${order.id}')">Подтвердить</button>` 
            : '-';

        tbody.innerHTML += `
            <tr>
                <td>${order.id}</td>
                <td>${order.summary}</td>
                <td>${order.contact}</td>
                <td><b>${order.total} ₽</b></td>
                <td><span class="status-badge ${statusClass}">${order.status}</span></td>
                <td><small>${actionBtn}</small></td>
            </tr>
        `;
    });
}

function deleteItem(id) {
    items = items.filter(item => item.id !== id);
    saveData();
    renderAdminItems();
    renderStorefront();
}

seedData();
checkExpiredOrders();
renderStorefront();