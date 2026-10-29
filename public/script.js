let currentPaymentType = 'main';

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      tabBtns.forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      currentPaymentType = e.target.getAttribute('data-type');
    });
  });
});

function updateTotal() {
  const amount = Number(document.getElementById('amountInput').value) || 0;
  document.getElementById('totalAmountDisplay').textContent =
    `${amount.toLocaleString('ru-RU')} ₽`;
}

async function handlePayment(e) {
  e.preventDefault();

  const item = document.getElementById('itemInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value) || 0;
  const email = document.getElementById('emailInput').value.trim();

  if (!item || amount <= 0 || !email.includes('@')) {
    showToast('Заполните позиции, сумму больше 0 ₽ и корректный E-mail 🌸');
    return;
  }

  const btn = document.getElementById('submitBtn');
  btn.textContent = 'ГЕНЕРАЦИЯ СЧЕТА СБП...';
  btn.disabled = true;

  try {
    const response = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item, amount, email, paymentType: currentPaymentType })
    });

    const data = await response.json();

    if (data.success && data.link) {
      showToast('Счёт создан! Перенаправляем на оплату...');
      setTimeout(() => {
        window.location.href = data.link;
      }, 600);
    } else {
      showToast(data.error || 'Ошибка формирования счёта.');
      btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ';
      btn.disabled = false;
    }
  } catch (err) {
    showToast('Ошибка соединения с сервером.');
    btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ';
    btn.disabled = false;
  }
}

function showToast(msg) {
  const box = document.getElementById('toastBox');
  box.textContent = msg;
  box.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    box.style.display = 'none';
  }, 3500);
}

let currentDeliveryCost = 0;

async function calculateDelivery() {
  const city = document.getElementById('cityInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value) || 0;
  const infoBox = document.getElementById('deliveryInfoBox');
  const costDisplay = document.getElementById('deliveryCostDisplay');

  if (!city) {
    infoBox.style.display = 'none';
    currentDeliveryCost = 0;
    updateTotal();
    return;
  }

  infoBox.style.display = 'block';
  costDisplay.textContent = 'считаем...';

  try {
    const response = await fetch('/api/delivery-calc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCity: city, cartValue: amount })
    });

    const data = await response.json();

    if (data.success) {
      currentDeliveryCost = data.deliveryPrice;
      costDisplay.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
      updateTotal(); 
    } else {
      costDisplay.textContent = 'Ошибка расчета';
      currentDeliveryCost = 0;
    }
  } catch (err) {
    costDisplay.textContent = 'Ошибка сети';
  }
}

function updateTotal() {
  const amount = Number(document.getElementById('amountInput').value) || 0;
  const total = amount + currentDeliveryCost;
  document.getElementById('totalAmountDisplay').textContent = `${total.toLocaleString('ru-RU')} ₽`;
}

updateTotal();
