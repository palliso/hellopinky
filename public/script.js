let currentPaymentType = 'main';
let currentDeliveryCost = 0;
let selectedDeliveryPointId = null;
let selectedDeliveryAddress = "";
let myMap = null;

document.addEventListener('DOMContentLoaded', () => {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const productFields = document.getElementById('productFields');
  const deliveryFields = document.getElementById('deliveryFields');

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
        if (!myMap) initMap(); // Загружаем карту только при переходе на вкладку
      } else {
        productFields.style.display = 'block';
        deliveryFields.style.display = 'none';
      }
      updateTotal();
    });
  });
});

async function initMap() {
    ymaps.ready(async function () {
        myMap = new ymaps.Map("map", {
            center: [56.838926, 60.605702], // Екатеринбург по умолчанию
            zoom: 11
        });

        // Запрашиваем ПВЗ с нашего сервера
        const res = await fetch('/api/pvz-map-data');
        const data = await res.json();

        if (data.points && data.points.length > 0) {
            let objectManager = new ymaps.ObjectManager({ clusterize: true });
            
            let features = data.points.map(p => ({
                type: 'Feature',
                id: p.id,
                geometry: { type: 'Point', coordinates: p.coords },
                properties: { balloonContent: `<b>${p.name}</b><br/>${p.address}<br/><button onclick="selectPvz(${p.id}, '${p.address}')" style="margin-top:5px; padding:5px; background:#ff4d85; color:white; border:none; border-radius:4px; cursor:pointer;">Выбрать этот ПВЗ</button>` }
            }));
            
            objectManager.add({ type: 'FeatureCollection', features: features });
            myMap.geoObjects.add(objectManager);
        }
    });
}

// Вызывается по кнопке из балуна на карте
window.selectPvz = function(id, address) {
    selectedDeliveryPointId = id;
    selectedDeliveryAddress = address;
    document.getElementById('selectedPvzText').innerText = `Выбран ПВЗ: ${address}`;
    myMap.balloon.close();
    triggerCalc();
};

function triggerCalc() {
    calculateDelivery();
}

async function calculateDelivery() {
    const tg = document.getElementById('tgInput').value.trim();
    const costBox = document.getElementById('deliveryInfoBox');
    const costDisplay = document.getElementById('deliveryCostDisplay');
    
    if (!selectedDeliveryPointId || !tg) {
        costBox.style.display = 'none';
        return;
    }
    
    costBox.style.display = 'block';
    costDisplay.textContent = 'ищем ваши заказы и считаем...';

    try {
        const response = await fetch('/api/delivery-calc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deliveryPointId: selectedDeliveryPointId, tgUser: tg })
        });

        const data = await response.json();

        if (data.success) {
            currentDeliveryCost = data.deliveryPrice;
            costDisplay.textContent = `${currentDeliveryCost.toLocaleString('ru-RU')} ₽`;
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
// Функция handlePayment остаётся без изменений
