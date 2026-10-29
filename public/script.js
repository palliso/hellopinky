let currentPaymentType = 'main';
let currentDeliveryCost = 0;
let selectedPvzId = null;

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  
  // Группы полей
  const productFields = document.getElementById('productFields');
  const deliveryFields = document.getElementById('deliveryFields');
  
  // Сами инпуты
  const itemInput = document.getElementById('itemInput');
  const amountInput = document.getElementById('amountInput');
  const fioInput = document.getElementById('fioInput');
  const phoneInput = document.getElementById('phoneInput');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault(); 
      
      // 1. Сбрасываем цвета всех кнопок
      tabBtns.forEach(b => {
        b.classList.remove('active');
        b.style.background = 'transparent';
        b.style.color = '#ff4d85';
      });
      
      // 2. Красим нажатую кнопку
      const clickedBtn = e.currentTarget;
      clickedBtn.classList.add('active');
      clickedBtn.style.background = '#ff4d85';
      clickedBtn.style.color = 'white';
      
      currentPaymentType = clickedBtn.getAttribute('data-type');

      // 3. Переключаем видимость и обязательность полей
      if (currentPaymentType === 'delivery') {
        productFields.style.display = 'none';
        deliveryFields.style.display = 'block';
        
        // Убираем обязательность с товаров, вешаем на доставку
        itemInput.required = false;
        amountInput.required = false;
        fioInput.required = true;
        phoneInput.required = true;
      } else {
        productFields.style.display = 'block';
        deliveryFields.style.display = 'none';
        
        // Возвращаем обязательность товарам, снимаем с доставки
        itemInput.required = true;
        amountInput.required = true;
        fioInput.required = false;
        phoneInput.required = false;
      }
      
      updateTotal();
    });
  });
  
  updateTotal();
});

// Единая функция обновления суммы
function updateTotal() {
  const display = document.getElementById('totalAmountDisplay');
  if (!display) return;

  if (currentPaymentType === 'delivery') {
    // На вкладке доставки показываем стоимость логистики
    display.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
  } else {
    // На обычных вкладках показываем сумму из поля
    const amount = Number(document.getElementById('amountInput').value) || 0;
    display.textContent = `${amount.toLocaleString('ru-RU')} ₽`;
  }
}

async function handlePayment(e) {
  e.preventDefault();

  const email = document.getElementById('emailInput').value.trim();
  const btn = document.getElementById('submitBtn');
  let finalItem = "";
  let finalAmount = 0;

  // Формируем данные в зависимости от вкладки
  if (currentPaymentType === 'delivery') {
    const fio = document.getElementById('fioInput').value.trim();
    const phone = document.getElementById('phoneInput').value.trim();
    
    if (!fio || !phone || !selectedPvzId) {
        showToast('Заполните ФИО, телефон и выберите ПВЗ на карте 🌸');
        return;
    }
    if (currentDeliveryCost <= 0) {
        showToast('Стоимость доставки еще не рассчитана.');
        return;
    }
    finalItem = `Доставка Ozon (${fio}, ПВЗ: ${selectedPvzId})`;
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

// Заглушка для карты Ozon
function openOzonWidget() {
    document.getElementById('ozonWidgetModal').style.display = 'block';
    
    // Временная имитация выбора (потом заменим на скрипт виджета Ozon)
    setTimeout(() => {
        handlePvzSelection({
            pvzId: "12345-TEST",
            address: "г. Тест, ул. Тестовая, 1",
            price: 350
        });
    }, 1500);
}

function closeOzonWidget() {
    document.getElementById('ozonWidgetModal').style.display = 'none';
}

function handlePvzSelection(pvzData) {
    selectedPvzId = pvzData.pvzId;
    currentDeliveryCost = pvzData.price;
    
    const addressBox = document.getElementById('selectedPvzAddress');
    const costBox = document.getElementById('deliveryInfoBox');
    
    if (addressBox) {
        addressBox.style.display = 'block';
        addressBox.textContent = `Выбран ПВЗ: ${pvzData.address}`;
    }
    
    if (costBox) {
        costBox.style.display = 'block';
        document.getElementById('deliveryCostDisplay').textContent = currentDeliveryCost.toLocaleString('ru-RU');
    }
    
    closeOzonWidget();
    updateTotal();
}
