let currentPaymentType = 'main';
let currentDeliveryCost = 0;

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const productFields = document.getElementById('productFields');
  const deliveryFields = document.getElementById('deliveryFields');
  const itemInput = document.getElementById('itemInput');
  const amountInput = document.getElementById('amountInput');
  const fioInput = document.getElementById('fioInput');
  const phoneInput = document.getElementById('phoneInput');
  const pvzAddressInput = document.getElementById('pvzAddressInput');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); 
      
      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.color = '#ff4d85';
      });
      
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
        fioInput.required = true;
        phoneInput.required = true;
        pvzAddressInput.required = true;
      } else {
        productFields.style.display = 'block';
        deliveryFields.style.display = 'none';
        itemInput.required = true;
        amountInput.required = true;
        fioInput.required = false;
        phoneInput.required = false;
        pvzAddressInput.required = false;
      }
      
      updateTotal();
    });
  });
  
  updateTotal();
});

function updateTotal() {
  const display = document.getElementById('totalAmountDisplay');
  if (!display) return;

  if (currentPaymentType === 'delivery') {
    display.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
  } else {
    const amount = Number(document.getElementById('amountInput').value) || 0;
    display.textContent = `${amount.toLocaleString('ru-RU')} ₽`;
  }
}

async function calculateDelivery() {
    const address = document.getElementById('pvzAddressInput').value.trim();
    const costBox = document.getElementById('deliveryInfoBox');
    const costDisplay = document.getElementById('deliveryCostDisplay');
    
    if (!address) {
        costBox.style.display = 'none';
        currentDeliveryCost = 0;
        updateTotal();
        return;
    }
    
    costBox.style.display = 'block';
    costDisplay.textContent = 'считаем через Ozon...';

    try {
        const response = await fetch('/api/delivery-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetCity: address, cartValue: 0 })
        });

        const data = await response.json();

        if (data.success) {
            currentDeliveryCost = data.deliveryPrice;
            costDisplay.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
        } else {
            costDisplay.textContent = 'Ошибка расчета сервером Ozon';
            currentDeliveryCost = 0;
        }
    } catch (err) {
        costDisplay.textContent = 'Ошибка сети';
        currentDeliveryCost = 0;
    }
    
    updateTotal();
}

async function handlePayment(e) {
  e.preventDefault();

  const email = document.getElementById('emailInput').value.trim();
  const btn = document.getElementById('submitBtn');
  let finalItem = "";
  let finalAmount = 0;

  if (currentPaymentType === 'delivery') {
    const fio = document.getElementById('fioInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const address = document.getElementById('pvzAddressInput').value.trim();
    
    if (!fio || !phone || !address) {
        showToast('Заполните ФИО, телефон и адрес ПВЗ 🌸');
        return;
    }
    if (currentDeliveryCost <= 0) {
        showToast('Дождитесь расчета стоимости доставки.');
        return;
    }
    finalItem = `Доставка (${fio}, ${address})`;
    finalAmount = currentDeliveryCost;
  } else {
    finalItem = document.getElementById('itemInput').value.trim();
    finalAmount = Number(document.getElementById('amountInput').value) || 0;
    
    if (!finalItem || finalAmount <= 0) {
        showToast('Заполните позиции и сумму больше 0 ₽ 🌸');
        return;
    }
  }

  if (!email.includes('@')) {
    showToast('Введите корректный E-mail 🌸');
    return;
  }

  if (btn) {
    btn.textContent = 'ГЕНЕРАЦИЯ СЧЕТА...';
    btn.disabled = true;
  }

  try {
    const response = await fetch('/api/pay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: finalItem, amount: finalAmount, email, paymentType: currentPaymentType })
    });

    const data = await response.json();

    if (data.success && data.link) {
      showToast('Счёт создан! Перенаправляем на оплату...');
      setTimeout(() => {
        window.location.href = data.link;
      }, 600);
    } else {
      showToast(data.error || 'Ошибка формирования счёта.');
      if (btn) {
        btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ';
        btn.disabled = false;
      }
    }
  } catch (err) {
    showToast('Ошибка соединения с сервером.');
    if (btn) {
      btn.textContent = 'ПЕРЕЙТИ К ОПЛАТЕ';
      btn.disabled = false;
    }
  }
}

function showToast(msg) {
  const box = document.getElementById('toastBox');
  if (!box) return;
  box.textContent = msg;
  box.style.display = 'block';
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    box.style.display = 'none';
  }, 3500);
}
