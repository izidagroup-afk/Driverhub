/**
 * Локальный mock портала Bolt Business / Ride Booker для e2e-тестов.
 * Не ходит в сеть; имитирует логин, Ride Booker, автодополнение и JSON API цен.
 */
import express from 'express';
import { createServer } from 'node:http';

const SESSION_COOKIE = 'bolt_mock_session';

/** @returns {import('express').Express & { setMockConfig: Function, getMockConfig: Function }} */
export function createMockPortal(initialConfig = {}) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  /** @type {Record<string, any>} */
  let mockConfig = {
    // После пароля показать поле OTP (никогда не принимает код).
    requireOtp: false,
    // После пароля показать экран согласия (без cookie / без кабинета).
    requireConsent: false,
    // Версия сессии: инкремент инвалидирует уже выданные cookie (протухшая сессия).
    sessionVersion: 1,
    // Страница Ride Booker без полей адресов.
    noAddressInputs: false,
    // Автодополнение не возвращает подсказки.
    noAutocomplete: false,
    // Задержка автодополнения, мс.
    autocompleteDelayMs: 250,
    // Режим ответа /api/rideEstimate: ok | error | empty | badSchema
    priceMode: 'ok',
    // Корректные учётки (сравниваются как есть).
    email: 'test@example.com',
    password: 'test-password',
    ...initialConfig,
  };

  app.setMockConfig = (patch) => {
    mockConfig = { ...mockConfig, ...patch };
  };
  app.getMockConfig = () => ({ ...mockConfig });
  /** Инвалидирует все ранее выданные session cookie. */
  app.invalidateSessions = () => {
    mockConfig.sessionVersion = Number(mockConfig.sessionVersion || 1) + 1;
  };

  function parseCookies(req) {
    const header = req.headers.cookie || '';
    const out = {};
    for (const part of header.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (!k) continue;
      out[k] = decodeURIComponent(rest.join('=') || '');
    }
    return out;
  }

  function isAuthed(req) {
    const expected = String(mockConfig.sessionVersion || 1);
    return parseCookies(req)[SESSION_COOKIE] === expected;
  }

  function requireAuth(req, res, next) {
    if (!isAuthed(req)) {
      return res.redirect('/');
    }
    next();
  }

  app.post('/__mock/config', (req, res) => {
    mockConfig = { ...mockConfig, ...req.body };
    res.json({ ok: true, config: mockConfig });
  });

  app.get('/__mock/config', (_req, res) => {
    res.json(mockConfig);
  });

  app.get('/', (req, res) => {
    if (isAuthed(req)) return res.redirect('/dashboard');
    res.type('html').send(loginPageHtml(mockConfig.requireOtp));
  });

  app.post('/login/email', (req, res) => {
    const email = String(req.body.email || '');
    if (email !== mockConfig.email) {
      return res.status(401).type('html').send(loginPageHtml(false, 'Unknown email'));
    }
    res.type('html').send(passwordPageHtml(email, mockConfig.requireOtp));
  });

  app.post('/login/password', (req, res) => {
    const email = String(req.body.email || '');
    const password = String(req.body.password || '');
    if (email !== mockConfig.email || password !== mockConfig.password) {
      return res.status(401).type('html').send(passwordPageHtml(email, false, 'Invalid credentials'));
    }
    if (mockConfig.requireOtp) {
      return res.type('html').send(otpPageHtml(email));
    }
    if (mockConfig.requireConsent) {
      return res.type('html').send(consentPageHtml(email));
    }
    const token = String(mockConfig.sessionVersion || 1);
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
    );
    res.redirect('/dashboard');
  });

  // OTP никогда не принимается — имитация «код не пришёл».
  app.post('/login/otp', (req, res) => {
    const email = String(req.body.email || '');
    res.status(401).type('html').send(otpPageHtml(email, 'Invalid or expired code'));
  });

  // Consent в автоматическом режиме не завершает вход (кнопка есть, но POST снова показывает consent).
  app.post('/login/consent', (req, res) => {
    const email = String(req.body.email || '');
    res.status(401).type('html').send(consentPageHtml(email, 'Please accept the terms to continue'));
  });

  app.get('/dashboard', requireAuth, (_req, res) => {
    res.type('html').send(dashboardHtml());
  });

  app.get('/ride-booker', requireAuth, (_req, res) => {
    res.type('html').send(rideBookerHtml(mockConfig));
  });

  // Фоновый ответ дашборда: объекты с name/price/id, которые НЕ должны стать тарифами.
  app.get('/api/dashboardStats', (_req, res) => {
    res.json({
      widgets: [
        { id: 'promo1', name: 'Summer promo', price: '€5', title: 'Discount' },
        { id: 'stat1', name: 'Trips this month', price: 42, title: 'Stats' },
      ],
    });
  });

  app.get('/api/places/autocomplete', requireAuth, (req, res) => {
    const q = String(req.query.q || '').trim();
    const delay = Number(mockConfig.autocompleteDelayMs) || 0;
    setTimeout(() => {
      if (mockConfig.noAutocomplete || q.length < 2) {
        return res.json({ suggestions: [] });
      }
      res.json({
        suggestions: [
          { id: '1', label: `${q} (Center)` },
          { id: '2', label: `${q} (Main Street)` },
          { id: '3', label: `${q}, Rīga` },
        ],
      });
    }, delay);
  });

  app.get('/api/rideEstimate', requireAuth, (req, res) => {
    const mode = mockConfig.priceMode || 'ok';
    if (mode === 'error') {
      return res.status(500).json({ error: 'internal_error', message: 'Upstream failed' });
    }
    if (mode === 'empty') {
      return res.json({ data: { ride_options: { categories: [] } } });
    }
    if (mode === 'badSchema') {
      return res.json({
        status: 'ok',
        widgets: [{ type: 'banner', title: 'Hello', id: 'w1' }],
        meta: { city: 'Rīga' },
      });
    }
    // Реалистичный вложенный payload с категориями поездки.
    res.json({
      data: {
        city: { name: 'Rīga', currency: 'EUR' },
        ride_options: {
          search_token: 'tok_mock_123',
          categories: [
            {
              category_id: 'bolt',
              category_name: 'Bolt',
              price_str: '€12.50',
              eta_str: '3 min',
              surge_multiplier: 1,
            },
            {
              category_id: 'comfort',
              category_name: 'Comfort',
              price: { amount: 15.2, currency: 'EUR' },
              pickup_eta: '4 min',
              surge_multiplier: 1,
            },
            {
              categoryId: 'xl',
              display_name: 'XL',
              price_string: '€18.90',
              eta: '5 min',
              surgeMultiplier: 1.2,
            },
            {
              // Без category_id — только category_name + price_str (частый кейс).
              category_name: 'Bolt Electric',
              price_str: '€13.10',
              eta_str: '6 min',
              surge_multiplier: 1,
            },
          ],
        },
      },
      // «Мусор», который не должен попасть в тарифы.
      notifications: [{ id: 'n1', name: 'Promo', title: 'Save 10%', price: 0 }],
    });
  });

  return app;
}

export async function startMockPortal(port = 0, initialConfig = {}) {
  const app = createMockPortal(initialConfig);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  return {
    app,
    server,
    port: actualPort,
    baseUrl,
    setConfig: (patch) => app.setMockConfig(patch),
    invalidateSessions: () => app.invalidateSessions(),
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loginPageHtml(requireOtp, error = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Log in</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}
  input,button{display:block;width:100%;margin:8px 0;padding:10px;font-size:16px;box-sizing:border-box}
  .error{color:#b00020}
</style></head>
<body>
  <h1>Log in to Bolt Business</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/login/email">
    <label>Email
      <input type="email" name="email" placeholder="Email" aria-label="Email" required />
    </label>
    <button type="submit">Continue</button>
  </form>
  <p data-otp-hint="${requireOtp ? '1' : '0'}" hidden></p>
</body></html>`;
}

function passwordPageHtml(email, requireOtp, error = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Log in</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}
  input,button{display:block;width:100%;margin:8px 0;padding:10px;font-size:16px;box-sizing:border-box}
  .error{color:#b00020}
</style></head>
<body>
  <h1>Enter password</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/login/password">
    <input type="hidden" name="email" value="${escapeHtml(email)}" />
    <label>Password
      <input type="password" name="password" placeholder="Password" aria-label="Password" required />
    </label>
    <button type="submit">Log in</button>
  </form>
</body></html>`;
}

function otpPageHtml(email, error = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Verify</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px}
  input,button{display:block;width:100%;margin:8px 0;padding:10px;font-size:16px;box-sizing:border-box}
  .error{color:#b00020}
</style></head>
<body>
  <h1>Enter verification code</h1>
  <p>We sent a code to your email. It may take a minute.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/login/otp">
    <input type="hidden" name="email" value="${escapeHtml(email)}" />
    <label>Code
      <input type="text" name="otp" inputmode="numeric" autocomplete="one-time-code"
             placeholder="Enter code" aria-label="Verification code" required />
    </label>
    <button type="submit">Verify</button>
  </form>
</body></html>`;
}

function consentPageHtml(email, error = '') {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Consent</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px}
  button{display:block;width:100%;margin:12px 0;padding:12px;font-size:16px}
  .error{color:#b00020}
</style></head>
<body>
  <h1>Terms and privacy consent</h1>
  <p>Please review and accept the terms of service and privacy policy to continue.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <form method="POST" action="/login/consent">
    <input type="hidden" name="email" value="${escapeHtml(email)}" />
    <label><input type="checkbox" name="agree" value="1" /> I agree to the terms</label>
    <button type="submit">Accept</button>
  </form>
</body></html>`;
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Dashboard</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;padding:24px}
  a.button,button{display:inline-block;padding:12px 18px;background:#34d186;color:#042;border:0;border-radius:8px;text-decoration:none;font-size:16px;cursor:pointer}
  /* Фоновый JSON-запрос дашборда — не должен попадать в тарифы */
</style></head>
<body>
  <h1>Dashboard</h1>
  <p>Welcome to Bolt Business</p>
  <a class="button" href="/ride-booker" role="button">Ride Booker</a>
  <script>
    // Имитируем «лишний» API дашборда с name/price/id — ловит баг раннего capture.
    fetch('/api/dashboardStats').catch(() => {});
  </script>
</body></html>`;
}

// Дашбордный endpoint без auth check в HTML fetch — зарегистрируем ниже через отдельный route на app.
// Добавляем в createMockPortal выше... actually need to add route inside createMockPortal.

function rideBookerHtml(mockConfig) {
  if (mockConfig.noAddressInputs) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><title>Ride Booker</title></head>
<body>
  <h1>Ride Booker</h1>
  <p>Booking temporarily unavailable.</p>
  <div class="promo">Special offer €5 off your next ride</div>
  <ul><li>News item without prices</li></ul>
</body></html>`;
  }

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><title>Bolt Business — Ride Booker</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px}
  .field{margin:16px 0;position:relative}
  input{width:100%;padding:12px;font-size:16px;box-sizing:border-box}
  .suggestions{border:1px solid #ccc;border-radius:8px;margin-top:4px;background:#fff}
  .suggestions [role="option"]{padding:10px 12px;cursor:pointer}
  .suggestions [role="option"]:hover,.suggestions [role="option"][aria-selected="true"]{background:#eef}
  .tariffs{margin-top:24px}
  .tariff{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #eee}
  .muted{color:#666}
</style></head>
<body>
  <h1>Ride Booker</h1>
  <p class="muted">Enter pickup and destination to see prices</p>

  <div class="field">
    <label for="pickup">Pickup</label>
    <input id="pickup" name="pickup" type="text"
           placeholder="Pickup address" aria-label="Pickup address" autocomplete="off" />
    <div id="pickup-suggestions" class="suggestions" role="listbox" hidden></div>
  </div>

  <div class="field">
    <label for="destination">Destination</label>
    <input id="destination" name="destination" type="text"
           placeholder="Destination address" aria-label="Destination address" autocomplete="off" />
    <div id="destination-suggestions" class="suggestions" role="listbox" hidden></div>
  </div>

  <!-- Ложные «тарифы» в DOM для проверки фолбэка / шума -->
  <ul class="footer-links">
    <li><a href="#">Help center</a></li>
    <li>Copyright 2026</li>
  </ul>

  <div id="tariffs" class="tariffs" hidden></div>

  <script>
    const selected = { pickup: null, destination: null };

    function debounce(fn, ms) {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    }

    async function loadSuggestions(inputId, boxId, query) {
      const box = document.getElementById(boxId);
      box.hidden = true;
      box.innerHTML = '';
      if (!query || query.length < 2) return;
      const res = await fetch('/api/places/autocomplete?q=' + encodeURIComponent(query));
      const data = await res.json();
      const items = data.suggestions || [];
      if (!items.length) return;
      for (const item of items) {
        const el = document.createElement('div');
        el.setAttribute('role', 'option');
        el.textContent = item.label;
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
          const input = document.getElementById(inputId);
          input.value = item.label;
          selected[inputId] = item.label;
          box.hidden = true;
          maybeFetchPrices();
        });
        box.appendChild(el);
      }
      box.hidden = false;
    }

    async function maybeFetchPrices() {
      if (!selected.pickup || !selected.destination) return;
      const box = document.getElementById('tariffs');
      box.hidden = false;
      box.innerHTML = '<p class="muted">Loading prices…</p>';
      try {
        const url = '/api/rideEstimate?pickup=' + encodeURIComponent(selected.pickup) +
          '&destination=' + encodeURIComponent(selected.destination);
        const res = await fetch(url);
        const data = await res.json();
        const cats = data?.data?.ride_options?.categories || [];
        if (!res.ok) {
          box.innerHTML = '<p class="muted">Price request failed</p>';
          return;
        }
        if (!cats.length) {
          box.innerHTML = '<p class="muted">No rides available</p>';
          return;
        }
        box.innerHTML = '';
        for (const c of cats) {
          const name = c.category_name || c.display_name || c.name || 'Ride';
          let price = c.price_str || c.price_string || '';
          if (!price && c.price && typeof c.price === 'object') {
            price = (c.price.amount != null ? c.price.amount : '') + ' ' + (c.price.currency || '');
          }
          const row = document.createElement('div');
          row.className = 'tariff';
          row.setAttribute('data-testid', 'ride-category');
          row.innerHTML = '<span class="category-name">' + name + '</span><span class="category-price">' +
            price + '</span>';
          box.appendChild(row);
        }
      } catch (err) {
        box.innerHTML = '<p class="muted">Failed to load prices</p>';
      }
    }

    document.getElementById('pickup').addEventListener('input', debounce((e) => {
      selected.pickup = null;
      loadSuggestions('pickup', 'pickup-suggestions', e.target.value);
    }, 150));
    document.getElementById('destination').addEventListener('input', debounce((e) => {
      selected.destination = null;
      loadSuggestions('destination', 'destination-suggestions', e.target.value);
    }, 150));
  </script>
</body></html>`;
}
