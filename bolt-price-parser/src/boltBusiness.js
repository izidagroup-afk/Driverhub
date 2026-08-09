import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { launch, saveSession, hasSession, ensureDebugDir } from './browser.js';
import { extractTariffs } from './priceExtractor.js';

const PICKUP_HINTS = ['pickup', 'pick up', 'pick-up', 'from', 'origin', 'откуда', 'начал'];
const DEST_HINTS = ['destination', 'drop', 'drop-off', 'dropoff', 'to', 'куда', 'конеч'];
const LOGIN_HINTS = ['log in', 'login', 'sign in', 'войти', 'e-mail', 'email', 'password'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isJsonResponse(response) {
  const ct = response.headers()['content-type'] || '';
  return ct.includes('application/json');
}

function isBoltApi(url) {
  return /bolt(svc)?\.(eu|net)/i.test(url) || url.includes('/api/');
}

/**
 * Подписывается на JSON-ответы бэкенда Bolt и складывает их для парсинга.
 */
function captureResponses(context) {
  const payloads = [];
  const handler = async (response) => {
    try {
      const url = response.url();
      if (!isBoltApi(url) || !isJsonResponse(response)) return;
      const body = await response.json().catch(() => null);
      if (body && typeof body === 'object') {
        payloads.push({ url, body });
      }
    } catch {
      /* игнорируем */
    }
  };
  context.on('response', handler);
  return {
    payloads,
    stop: () => context.off('response', handler),
  };
}

async function findInputByHints(page, hints) {
  const inputs = page.locator('input:visible');
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    const attrs = (
      (await input.getAttribute('placeholder')) +
      ' ' +
      (await input.getAttribute('aria-label')) +
      ' ' +
      (await input.getAttribute('name')) +
      ' ' +
      (await input.getAttribute('id'))
    ).toLowerCase();
    if (hints.some((h) => attrs.includes(h))) return input;
  }
  return null;
}

async function isLoginPage(page) {
  const url = page.url();
  if (/login|signin|sign-in|auth/i.test(url)) return true;
  const passwordVisible = await page
    .locator('input[type="password"]:visible')
    .count()
    .catch(() => 0);
  return passwordVisible > 0;
}

/**
 * Выполняет вход по email/паролю. В интерактивном (headed) режиме ждёт, пока
 * пользователь завершит ввод OTP/2FA вручную.
 */
export async function performLogin(page, { interactive = false } = {}) {
  await page.goto(config.bolt.baseUrl, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  if (!(await isLoginPage(page))) return true; // уже залогинены

  // Иногда сначала показывается поле email, затем — пароль.
  const emailInput =
    (await findInputByHints(page, ['email', 'e-mail', 'почт'])) ||
    page.locator('input[type="email"]:visible').first();
  if (await emailInput.count?.().catch(() => 1)) {
    try {
      await emailInput.fill(config.bolt.email, { timeout: 8000 });
    } catch {
      /* поле могло быть не найдено */
    }
  }

  // Нажимаем «продолжить», если пароль ещё не показан.
  let passwordInput = page.locator('input[type="password"]:visible').first();
  if ((await passwordInput.count()) === 0) {
    await clickByText(page, ['continue', 'next', 'далее', 'продолжить', 'log in', 'войти']);
    await sleep(1500);
    passwordInput = page.locator('input[type="password"]:visible').first();
  }

  if (await passwordInput.count()) {
    await passwordInput.fill(config.bolt.password, { timeout: 8000 });
    await clickByText(page, ['log in', 'sign in', 'войти', 'continue', 'submit']);
  }

  // Ожидание завершения логина (или ручного ввода OTP в интерактиве).
  const deadline = Date.now() + (interactive ? 5 * 60 * 1000 : 20000);
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!(await isLoginPage(page))) return true;
    if (interactive) {
      // Даём пользователю время ввести код из письма/СМС в открытом браузере.
      continue;
    }
  }

  if (await isLoginPage(page)) {
    throw new Error(
      'Не удалось автоматически войти в Bolt Business (вероятно, требуется код подтверждения/2FA). ' +
        'Запустите один раз интерактивный вход: `npm run login`, завершите вход вручную — сессия сохранится.'
    );
  }
  return true;
}

async function clickByText(page, texts) {
  for (const t of texts) {
    const btn = page
      .locator(`button:visible, [role="button"]:visible, a:visible`)
      .filter({ hasText: new RegExp(t, 'i') })
      .first();
    if (await btn.count()) {
      try {
        await btn.click({ timeout: 5000 });
        return true;
      } catch {
        /* пробуем следующий вариант */
      }
    }
  }
  return false;
}

async function typeAddress(page, input, value) {
  await input.click();
  await input.fill('');
  await input.type(value, { delay: 40 });
  // Ждём появления списка подсказок и выбираем первую.
  await sleep(1800);
  const suggestion = page
    .locator('[role="option"]:visible, li:visible, [class*="suggestion" i]:visible, [class*="autocomplete" i] *:visible')
    .first();
  if (await suggestion.count()) {
    try {
      await suggestion.click({ timeout: 5000 });
      return;
    } catch {
      /* fallback ниже */
    }
  }
  await input.press('ArrowDown');
  await input.press('Enter');
}

async function dumpDebug(page, payloads, tag) {
  const dir = ensureDebugDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = path.join(dir, `${tag}-${stamp}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  fs.writeFileSync(
    path.join(dir, `${tag}-${stamp}.json`),
    JSON.stringify(payloads, null, 2)
  );
  return shot;
}

/**
 * DOM-фолбэк: пытается прочитать список тарифов прямо со страницы.
 */
async function scrapeDomTariffs(page) {
  return page
    .evaluate(() => {
      const results = [];
      const priceRe = /(€|EUR|\$|£)\s?\d|\d[\d\s.,]*\s?(€|EUR|\$|£)/i;
      const nodes = Array.from(document.querySelectorAll('li, [class*="category" i], [class*="option" i], [class*="ride" i]'));
      for (const node of nodes) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 80) continue;
        if (!priceRe.test(text)) continue;
        const priceMatch = text.match(/((€|EUR|\$|£)\s?\d[\d\s.,]*|\d[\d\s.,]*\s?(€|EUR|\$|£))/i);
        const price = priceMatch ? priceMatch[0].trim() : null;
        const name = price ? text.replace(price, '').trim() : text;
        if (name) results.push({ name, price, eta: null, surge: null });
      }
      return results;
    })
    .catch(() => []);
}

/**
 * Основной метод: возвращает актуальные тарифы Bolt для маршрута.
 * @param {{pickup:string, destination:string}} params
 */
export async function getPrices({ pickup, destination }) {
  if (!pickup || !destination) {
    throw new Error('Нужно указать адреса начала (pickup) и конца (destination).');
  }

  const { browser, context } = await launch({ useSession: true });
  const capture = captureResponses(context);
  const page = await context.newPage();

  try {
    await performLogin(page, { interactive: false });
    await saveSession(context); // обновляем сессию

    // Переходим к инструменту заказа/оценки.
    await page.goto(config.bolt.baseUrl, { waitUntil: 'domcontentloaded' });
    await sleep(2000);
    await clickByText(page, ['ride booker', 'book a ride', 'new ride', 'order', 'заказ']);
    await sleep(1500);

    const pickupInput = await findInputByHints(page, PICKUP_HINTS);
    const destInput = await findInputByHints(page, DEST_HINTS);
    if (!pickupInput || !destInput) {
      const shot = config.debug ? await dumpDebug(page, capture.payloads, 'no-inputs') : null;
      throw new Error(
        'Не найдены поля адресов на странице заказа. Возможно, изменилась вёрстка портала. ' +
          (shot ? `Скриншот: ${shot}` : 'Включите DEBUG_CAPTURE=1 для скриншота.')
      );
    }

    await typeAddress(page, pickupInput, pickup);
    await typeAddress(page, destInput, destination);

    // Ждём подгрузки цен (сеть + рендер).
    await sleep(4000);

    let tariffs = extractTariffs(capture.payloads.map((p) => p.body));
    if (tariffs.length === 0) {
      tariffs = await scrapeDomTariffs(page);
    }

    const debugShot = config.debug ? await dumpDebug(page, capture.payloads, 'result') : null;

    return {
      pickup,
      destination,
      city: config.bolt.defaultCity,
      currency: guessCurrency(tariffs),
      fetchedAt: new Date().toISOString(),
      tariffs,
      source: 'bolt-business-web',
      ...(debugShot ? { debugScreenshot: debugShot } : {}),
    };
  } finally {
    capture.stop();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function guessCurrency(tariffs) {
  for (const t of tariffs) {
    if (!t.price) continue;
    const m = t.price.match(/€|EUR|\$|£|USD|GBP/i);
    if (m) return m[0];
  }
  return null;
}

export { hasSession };
