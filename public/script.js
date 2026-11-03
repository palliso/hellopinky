let currentPaymentType = 'main';
let currentDeliveryCost = 0;
let confirmedPvzAddress = "";

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const productFields = document.getElementById('productFields');
  const deliveryFields = document.getElementById('deliveryFields');
  const itemInput = document.getElementById('itemInput');
  const amountInput = document.getElementById('amountInput');
  const tgInput = document.getElementById('tgInput');
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
        tgInput.required = true;
        phoneInput.required = true;
        pvzAddressInput.required = true;
      } else {
        productFields.style.display = 'block';
        deliveryFields.style.display = 'none';
        itemInput.required = true;
        amountInput.required = true;
        tgInput.required = false;
        phoneInput.required = false;
        pvzAddressInput.required = false;
      }
      updateTotal();
    });
  });
});

async function calculateDelivery() {
    const address = document.getElementById('pvzAddressInput').value.trim();
    const tg = document.getElementById('tgInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    const costBox = document.getElementById('deliveryInfoBox');
    const costDisplay = document.getElementById('deliveryCostDisplay');
    
    if (!address || !tg) {
        costBox.style.display = 'none';
        currentDeliveryCost = 0;
        updateTotal();
        return;
    }
    
    costBox.style.display = 'block';
    costDisplay.textContent = 'ищем ПВЗ и считаем...';

    try {
        const response = await fetch('/api/delivery-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetAddress: address, tgUser: tg, phone: phone })
        });

        const data = await response.json();

        if (data.success) {
            currentDeliveryCost = data.deliveryPrice;
            confirmedPvzAddress = data.foundAddress;
            costDisplay.innerHTML = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽ <br><span style="font-size:11px; color:#666;">(Найден: ${confirmedPvzAddress})</span>`;
        } else {
            costDisplay.textContent = data.error || 'Ошибка расчета';
            currentDeliveryCost = 0;
            confirmedPvzAddress = "";
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
    const phone = document.getElementById('phoneInput').value.trim();
    
    if (currentDeliveryCost <= 0 || !confirmedPvzAddress) {
        showToast('Сначала нажмите "СЧИТАТЬ" и дождитесь расчета стоимости.');
        return;
    }
    if (!phone) {
        showToast('Пожалуйста, укажите номер телефона.');
        return;
    }
    finalItem = `Доставка Ozon (${tg}, тел: ${phone}, ПВЗ: ${confirmedPvzAddress})`;
    finalAmount = currentDeliveryCost;
  } else {
    let typeName = currentPaymentType === 'preorder' ? 'Предзаказ' : 'Оплата';
    finalItem = `${typeName}: ${document.getElementById('itemInput').value.trim()}`;
    finalAmount = Number(document.getElementById('amountInput').value) || 0;
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

let suggestTimer;
let selectedPvzId = null;

async function suggestPvz() {
    const input = document.getElementById('pvzAddressInput').value.trim();
    const list = document.getElementById('autocompleteList');
    selectedPvzId = null; // Сбрасываем выбранный ID при изменении текста
    
    if (input.length < 3) {
        list.style.display = 'none';
        return;
    }

    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
        try {
            const res = await fetch(`/api/pvz-suggest?q=${encodeURIComponent(input)}`);
            const data = await res.json();
            
            list.innerHTML = '';
            if (data.points && data.points.length > 0) {
                data.points.forEach(p => {
                    const li = document.createElement('li');
                    li.style.cssText = 'padding: 10px; border-bottom: 1px solid #f0f0f0; cursor: pointer; font-size: 12px; color: #333; line-height: 1.4;';
                    li.innerHTML = p.address.replace(new RegExp(input, 'gi'), match => `<b style="color:#ff4d85;">${match}</b>`);
                    
                    // По клику на подсказку
                    li.onclick = () => {
                        document.getElementById('pvzAddressInput').value = p.address;
                        selectedPvzId = p.id;
                        list.style.display = 'none';
                        calculateDelivery(); // Сразу запускаем расчет!
                    };
                    
                    list.appendChild(li);
                });
                list.style.display = 'block';
            } else {
                list.style.display = 'none';
            }
        } catch (e) {
            list.style.display = 'none';
        }
    }, 400); // Ждем 400мс, чтобы не спамить запросами пока человек печатает
}

// Прятать список при клике в другое место
document.addEventListener('click', function(e) {
    if (e.target.id !== 'pvzAddressInput') {
        document.getElementById('autocompleteList').style.display = 'none';
    }
});
