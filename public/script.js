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
      body: JSON.stringify({ item, amount, email })
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

updateTotal();