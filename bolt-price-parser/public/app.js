const form = document.getElementById('form');
const submitBtn = document.getElementById('submit');
const messageEl = document.getElementById('message');
const resultsEl = document.getElementById('results');
const tariffsBody = document.getElementById('tariffs-body');
const routeEl = document.getElementById('route');
const fetchedAtEl = document.getElementById('fetchedAt');
const statusEl = document.getElementById('status');

function showMessage(text, kind = 'error') {
  messageEl.hidden = false;
  messageEl.textContent = text;
  messageEl.className = 'message' + (kind === 'info' ? ' message--info' : '');
}

function hideMessage() {
  messageEl.hidden = true;
}

async function refreshStatus() {
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (!data.credentialsConfigured) {
      statusEl.textContent = 'нет доступов (.env)';
      statusEl.className = 'status status--warn';
    } else if (!data.hasSession) {
      statusEl.textContent = 'нет сессии — нужен вход';
      statusEl.className = 'status status--warn';
    } else {
      statusEl.textContent = `готово · ${data.city || ''}`.trim();
      statusEl.className = 'status status--ok';
    }
  } catch {
    statusEl.textContent = 'сервер недоступен';
    statusEl.className = 'status status--warn';
  }
}

function renderTariffs(data) {
  tariffsBody.innerHTML = '';
  if (!data.tariffs || data.tariffs.length === 0) {
    showMessage(
      'Цены не найдены. Проверьте адреса и статус сессии. При необходимости включите ' +
        'DEBUG_CAPTURE=1 на сервере и посмотрите скриншот в папке .debug.',
      'info'
    );
    resultsEl.hidden = true;
    return;
  }

  for (const t of data.tariffs) {
    const tr = document.createElement('tr');
    const surge =
      t.surge && t.surge > 1
        ? `<span class="surge-badge">×${t.surge}</span>`
        : `<span class="surge-badge surge-badge--none">—</span>`;
    tr.innerHTML = `
      <td>${escapeHtml(t.name || '—')}</td>
      <td class="price">${escapeHtml(t.price || '—')}</td>
      <td>${escapeHtml(t.eta || '—')}</td>
      <td>${surge}</td>
    `;
    tariffsBody.appendChild(tr);
  }

  routeEl.textContent = `${data.pickup} → ${data.destination}`;
  const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString() : '';
  fetchedAtEl.textContent = when
    ? `обновлено ${when}${data.elapsedMs ? ` · ${(data.elapsedMs / 1000).toFixed(1)}с` : ''}`
    : '';
  resultsEl.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage();
  resultsEl.hidden = true;

  const pickup = document.getElementById('pickup').value.trim();
  const destination = document.getElementById('destination').value.trim();
  if (!pickup || !destination) return;

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<span class="spinner"></span>Получаю цены…';

  try {
    const res = await fetch('/api/prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pickup, destination }),
    });
    const data = await res.json();
    if (!res.ok) {
      showMessage(data.error || 'Ошибка запроса.');
    } else {
      renderTariffs(data);
    }
  } catch (err) {
    showMessage('Сеть недоступна: ' + err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Узнать цены';
    refreshStatus();
  }
});

refreshStatus();
