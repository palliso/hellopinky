let currentPaymentType = 'main';
let currentDeliveryCost = 0;

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const productFields = document.getElementById('productFields');
  const deliveryFields = document.getElementById('deliveryFields');
  const itemInput = document.getElementById('itemInput');
  const amountInput = document.getElementById('amountInput');
  const tgInput = document.getElementById('tgInput');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); 
      tabBtns.forEach(b => { b.classList.remove('active'); b.style.background = 'transparent'; b.style.color = '#ff4d85'; });
      
      const clickedBtn = e.currentTarget;
      clickedBtn.classList.add('active');
      clickedBtn.style.background = '#ff4d85';
      clickedBtn.style.color = 'white';
      
      currentPaymentType = clickedBtn.getAttribute('data-type');

      if (currentPaymentType === 'delivery') {
        productFields.style.display = 'none';
        deliveryFields.style.display = 'block';
        itemInput.required = false;
        amountInput.required = false;
      } else {
        productFields.style.display = 'block';
        deliveryFields.style.display = 'none';
        itemInput.required = true;
        amountInput.required = true;
      }
      updateTotal();
    });
  });
});

async function calculateDelivery() {
    const tg = document.getElementById('tgInput').value.trim();
    const costBox = document.getElementById('deliveryInfoBox');
    const costDisplay = document.getElementById('deliveryCostDisplay');
    const boxDisplay = document.getElementById('boxInfoDisplay');
    
    if (!tg) return;
    
    costBox.style.display = 'block';
    costDisplay.textContent = 'считаем...';
    boxDisplay.textContent = '';

    try {
        const response = await fetch('/api/delivery-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tgUser: tg })
        });

        const data = await response.json();

        if (data.success) {
            currentDeliveryCost = data.deliveryPrice;
            costDisplay.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
            boxDisplay.textContent = data.boxInfo; // Выводит размеры коробки!
        } else {
            costDisplay.textContent = data.error || 'Ошибка расчета';
            currentDeliveryCost = 0;
        }
    } catch (err) {
        costDisplay.textContent = 'Ошибка сети';
        currentDeliveryCost = 0;
    }
    updateTotal();
}

function updateTotal() {
  const display = document.getElementById('totalAmountDisplay');
  if (currentPaymentType === 'delivery') {
    display.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
  } else {
    display.textContent = `${(Number(document.getElementById('amountInput').value) || 0).toLocaleString('ru-RU')} ₽`;
  }
}

async function handlePayment(e) {
  e.preventDefault();

  const email = document.getElementById('emailInput').value.trim();
  const btn = document.getElementById('submitBtn');
  let finalItem = "";
  let finalAmount = 0;

  if (currentPaymentType === 'delivery') {
    const tg = document.getElementById('tgInput').value.trim();
    if (currentDeliveryCost <= 0) { showToast('Сначала рассчитайте доставку.'); return; }
    
    finalItem = `Доставка Ozon (${tg})`;
    finalAmount = currentDeliveryCost;
  } else {
    finalItem = document.getElementById('itemInput').value.trim();
    finalAmount = Number(document.getElementById('amountInput').value) || 0;
  }

  if (btn) { btn.textContent = 'ГЕНЕРАЦИЯ СЧЕТА...'; btn.disabled = true; }

  try {
    const response = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: finalItem, amount: finalAmount, email, paymentType: currentPaymentType })
    });

    const data = await response.json();
    if (data.success && data.link) {
      showToast('Счёт создан!');
      setTimeout(() => window.location.href = data.link, 600);
    } else {
      showToast(data.error || 'Ошибка формирования счёта.');
      if (btn) { btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ'; btn.disabled = false; }
    }
  } catch (err) {
    showToast('Ошибка соединения.');
    if (btn) { btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ'; btn.disabled = false; }
  }
}

function showToast(msg) {
  const box = document.getElementById('toastBox');
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => box.style.display = 'none', 3500);
}
