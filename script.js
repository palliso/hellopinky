// Состояние приложения (сохраняется в localStorage для удобного теста на GitHub Pages)
const state = {
  waiting: JSON.parse(localStorage.getItem('hp_waiting') || '{}'),
  receipts: JSON.parse(localStorage.getItem('hp_receipts') || '[]'),
  logs: JSON.parse(localStorage.getItem('hp_logs') || '[]'),
  lastQrcId: null
};

// Добавление записи в лог робота
function addLog(msg) {
  const now = new Date().toLocaleTimeString('ru-RU');
  state.logs.push(`[${now}] ${msg}`);
  if (state.logs.length > 30) state.logs.shift();
  localStorage.setItem('hp_logs', JSON.stringify(state.logs));
  renderLogs();
}

function saveState() {
  localStorage.setItem('hp_waiting', JSON.stringify(state.waiting));
  localStorage.setItem('hp_receipts', JSON.stringify(state.receipts));
  updateCounters();
}

// Загрузка и сохранение настроек кассы
function loadSettings() {
  const cfg = JSON.parse(localStorage.getItem('hp_settings') || '{}');
  if (cfg.inn) document.getElementById('cfgInn').value = cfg.inn;
  if (cfg.tax) document.getElementById('cfgTax').value = cfg.tax;
  if (cfg.method) document.getElementById('cfgMethod').value = cfg.method;
}

function saveSettings() {
  const cfg = {
    inn: document.getElementById('cfgInn').value.trim(),
    tax: document.getElementById('cfgTax').value,
    method: document.getElementById('cfgMethod').value
  };
  localStorage.setItem('hp_settings', JSON.stringify(cfg));
  updateTotalAndPreview();
}

// Чтение URL-параметров (если клиент открыл готовую ссылку или открыт ?admin=1)
function initFromUrl() {
  const params = new URLSearchParams(window.location.search);

  if (params.has('item')) {
    document.getElementById('itemDescInput').value = params.get('item');
  }
  if (params.has('amount')) {
    document.getElementById('amountInput').value = Number(params.get('amount')) || 0;
  }
  if (params.has('email')) {
    document.getElementById('emailInput').value = params.get('email');
  }

  // Если ссылка для покупателя (?client=1), прячем верхние вкладки
  if (params.get('client') === '1') {
    document.getElementById('modeSwitcher').style.display = 'none';
  }
}

// Переключение вкладок
function switchTab(tabName, btnEl) {
  document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
  document.getElementById(`tab-${tabName}`).classList.add('active');

  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  if (btnEl) btnEl.classList.add('active');

  if (tabName === 'link') updateClientLink();
  if (tabName === 'history') renderHistory();
  if (tabName === 'settings') renderLogs();
}

// Кнопки - и + для поля Сумма (₽)
function changeAmount(delta) {
  const input = document.getElementById('amountInput');
  const current = Number(input.value) || 0;
  input.value = Math.max(0, current + delta);
  updateTotalAndPreview();
}

// Формирование точного payload чека CloudKassir (как в функции send_receipt из твоего кода)
function buildCloudKassirPayload(amount, email, itemName) {
  const inn = document.getElementById('cfgInn')?.value.trim() || '667100000000';
  const taxSystem = Number(document.getElementById('cfgTax')?.value || 1);
  const method = Number(document.getElementById('cfgMethod')?.value || 1);

  return {
    Inn: inn,
    Type: 'Income',
    CustomerReceipt: {
      Items: [
        {
          label: itemName || 'Заказ в магазине hellopinky',
          price: Number(amount),
          quantity: 1,
          amount: Number(amount),
          vat: null,
          method: method,
          object: 1
        }
      ],
      taxationSystem: taxSystem,
      email: email || 'client@hellopinky.ru'
    }
  };
}

// Обновление плашки "Итого по чеку" и JSON-превью
function updateTotalAndPreview() {
  const itemDesc = document.getElementById('itemDescInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value) || 0;
  const email = document.getElementById('emailInput').value.trim();

  document.getElementById('totalAmountDisplay').textContent =
    `${amount.toLocaleString('ru-RU')} ₽`;

  const payload = buildCloudKassirPayload(amount, email, itemDesc);
  const previewBox = document.getElementById('jsonPreviewBox');
  if (previewBox) {
    previewBox.textContent = JSON.stringify(payload, null, 2);
  }

  updateClientLink();
}

function toggleJsonPreview() {
  const box = document.getElementById('jsonPreviewBox');
  box.style.display = box.style.display === 'block' ? 'none' : 'block';
  updateTotalAndPreview();
}

function quickDemoFill() {
  document.getElementById('itemDescInput').value = 'Блайнд-бокс HelloPinky + протекторы';
  document.getElementById('amountInput').value = 1500;
  document.getElementById('emailInput').value = 'client@hellopinky.ru';
  updateTotalAndPreview();
  showToast('Демо-данные подставлены 🌸');
}

// Создание динамического QR СБП и постановка в очередь робота
function handleCreatePayment(e) {
  e.preventDefault();

  const itemDesc = document.getElementById('itemDescInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value);
  const email = document.getElementById('emailInput').value.trim();

  if (!itemDesc || amount <= 0 || !email.includes('@')) {
    showToast('Заполните позиции, сумму больше 0 ₽ и корректный E-mail 🌸');
    return;
  }

  // Генерируем тестовый qrcId (как в API Модульбанка)
  const qrcId = 'QRC-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const demoSbpLink = `https://qr.nspk.ru/${qrcId}?type=02&sum=${amount * 100}&cur=RUB`;

  state.waiting[qrcId] = {
    qrcId: qrcId,
    email: email,
    item: itemDesc,
    amount: amount,
    created_at: Date.now()
  };
  state.lastQrcId = qrcId;

  saveState();
  addLog(`🌸 Создан динамический СБП QR (${qrcId}) на ${amount} ₽ для ${email}`);

  // Показываем блок оплаты СБП
  const sbpBlock = document.getElementById('sbpPaymentBlock');
  document.getElementById('sbpOrderDetails').textContent =
    `ID QR: ${qrcId} • Позиция: «${itemDesc}» • Чек уйдёт на ${email}`;
  const linkBtn = document.getElementById('sbpPayLink');
  linkBtn.textContent = `🔥 ОПЛАТИТЬ ${amount.toLocaleString('ru-RU')} ₽ ПО СБП`;
  linkBtn.href = demoSbpLink;
  sbpBlock.style.display = 'block';

  showToast(`Счёт СБП на ${amount} ₽ создан! Ожидаем оплату...`);
}

// Симуляция ответа "Accepted" от Модульбанка и отправка чека в CloudKassir
function simulateBankAccepted(targetQrcId) {
  const qrcId = targetQrcId || state.lastQrcId || Object.keys(state.waiting)[0];
  const order = state.waiting[qrcId];

  if (!order) {
    showToast('Нет активных заказов в очереди ожидания СБП');
    return;
  }

  // Формируем чек CloudKassir
  const receiptPayload = buildCloudKassirPayload(order.amount, order.email, order.item);
  const fiscalNumber = 'ФД-' + Math.floor(10000000 + Math.random() * 90000000);

  state.receipts.unshift({
    qrcId: qrcId,
    fiscalNumber: fiscalNumber,
    date: new Date().toLocaleString('ru-RU'),
    email: order.email,
    item: order.item,
    amount: order.amount,
    payload: receiptPayload
  });

  delete state.waiting[qrcId];
  saveState();

  addLog(`✅ Статус QR ${qrcId} = Accepted! Чек ${fiscalNumber} отправлен на ${order.email}`);
  document.getElementById('sbpPaymentBlock').style.display = 'none';
  showToast(`Оплата подтверждена! Чек ${fiscalNumber} отправлен на ${order.email} 💖`);
}

// Генерация ссылки для отправки покупателю
function updateClientLink() {
  const baseUrl = window.location.origin + window.location.pathname;
  const itemDesc = document.getElementById('itemDescInput').value.trim();
  const amount = Number(document.getElementById('amountInput').value) || 0;

  const params = new URLSearchParams();
  params.set('client', '1');
  if (itemDesc) params.set('item', itemDesc);
  if (amount > 0) params.set('amount', String(amount));

  const linkInput = document.getElementById('generatedLinkInput');
  if (linkInput) {
    linkInput.value = `${baseUrl}?${params.toString()}`;
  }
}

function copyClientLink() {
  updateClientLink();
  const input = document.getElementById('generatedLinkInput');
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('Ссылка для клиента скопирована 🌸');
  });
}

// Отрисовка истории чеков и логов робота
function updateCounters() {
  document.getElementById('receiptsCount').textContent = state.receipts.length;
  const waitingCount = Object.keys(state.waiting).length;
  const badge = document.getElementById('waitingCounterBadge');
  if (badge) badge.textContent = `В очереди: ${waitingCount}`;
}

function renderHistory() {
  const list = document.getElementById('receiptsHistoryList');
  if (state.receipts.length === 0) {
    list.innerHTML = `<div style="text-align:center; padding: 26px; color: var(--text-muted); font-size: 13px;">
      Пробитых чеков пока нет 🌸
    </div>`;
    return;
  }

  list.innerHTML = state.receipts.map(r => `
    <div class="history-item">
      <div class="history-top">
        <span>${r.item} — ${r.amount.toLocaleString('ru-RU')} ₽</span>
        <span class="status-ok">✅ ${r.fiscalNumber}</span>
      </div>
      <div style="color: var(--text-muted);">
        ${r.date} • E-mail: <b>${r.email}</b> • QR: ${r.qrcId}
      </div>
    </div>
  `).join('');
}

function clearHistory() {
  state.receipts = [];
  saveState();
  renderHistory();
  showToast('История чеков очищена');
}

function renderLogs() {
  const area = document.getElementById('robotLogsArea');
  if (!area) return;
  area.value = [...state.logs].reverse().join('\n');
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

// Запуск при открытии страницы
loadSettings();
initFromUrl();
updateTotalAndPreview();
updateCounters();
if (state.logs.length === 0) {
  addLog('🤖 Робот hellopinky запущен (тестовый режим GitHub Pages).');
}
