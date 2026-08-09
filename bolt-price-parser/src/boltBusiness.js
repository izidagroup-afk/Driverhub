import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { launch, saveSession, hasSession, ensureDebugDir } from './browser.js';
import { extractTariffs } from './priceExtractor.js';

// Более специфичные подсказки первыми. Короткие ('to'/'from') учитываются
// только как целые слова при скоринге — см. scoreInputAgainstHints.
const PICKUP_HINTS = ['pickup address', 'pick-up', 'pick up', 'pickup', 'origin', 'откуда', 'начал', 'from'];
const DEST_HINTS = [
  'destination address',
  'drop-off',
  'dropoff',
  'destination',
  'drop off',
  'куда',
  'конеч',
  'to',
];
const OTP_INPUT =
  'input[autocomplete="one-time-code"]:visible, input[name*="otp" i]:visible, input[placeholder*="code" i]:visible, input[aria-label*="code" i]:visible, input[aria-label*="verification" i]:visible';

function withTimeout(promise, ms, message) {
  let timer;
  const guarded = Promise.resolve(promise);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([
    guarded.finally(() => clearTimeout(timer)),
    timeout,
  ]).finally(() => {
    // Если сработал таймаут — не оставляем unhandled rejection у исходного промиса.
    guarded.catch(() => {});
  });
}

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
      // Оценку поездки/категории интересуют в первую очередь; остальное тоже копим,
      // но буфер очищается перед вводом адресов (см. getPricesInternal).
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
    clear() {
      payloads.length = 0;
    },
    stop: () => context.off('response', handler),
  };
}

function attrsText(parts) {
  return parts.filter((p) => typeof p === 'string' && p.length > 0).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Оценка совпадения поля ввода с подсказками. Короткие токены (< 3) — только как целые слова.
 */
function scoreInputAgainstHints(attrs, hints) {
  if (!attrs) return 0;
  let score = 0;
  for (const raw of hints) {
    const hint = String(raw).toLowerCase().trim();
    if (!hint) continue;
    if (attrs === hint) {
      score += 100;
      continue;
    }
    if (attrs.startsWith(hint + ' ') || attrs.endsWith(' ' + hint) || attrs.includes(' ' + hint + ' ')) {
      score += 70;
      continue;
    }
    if (hint.length >= 4 && attrs.includes(hint)) {
      // Длинная подстрока: «pickup» в «pickup address».
      score += 40 + Math.min(hint.length, 20);
      continue;
    }
    if (hint.length < 4) {
      // «to» / «from» — только границы слова, иначе «autocomplete»/«information».
      const re = new RegExp(`(?:^|[^a-z])${hint}(?:[^a-z]|$)`, 'i');
      if (re.test(attrs)) score += 15;
    }
  }
  return score;
}

/**
 * Ищет видимый input по подсказкам placeholder/aria-label/name/id.
 * Выбирает лучший по score; можно исключить уже выбранный элемент (pickup ≠ destination).
 */
async function findInputByHints(page, hints, { exclude = null } = {}) {
  const inputs = page.locator(
    'input:visible:not([type="hidden"]):not([type="password"]):not([type="email"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"])'
  );
  const count = await inputs.count();
  let best = null;
  let bestScore = 0;

  for (let i = 0; i < count; i++) {
    const input = inputs.nth(i);
    if (exclude) {
      const handle = await exclude.elementHandle().catch(() => null);
      if (handle) {
        const same = await input.evaluate((el, other) => el === other, handle).catch(() => false);
        await handle.dispose().catch(() => {});
        if (same) continue;
      }
    }

    const parts = await Promise.all([
      input.getAttribute('placeholder'),
      input.getAttribute('aria-label'),
      input.getAttribute('name'),
      input.getAttribute('id'),
      input.getAttribute('data-testid'),
    ]);
    const attrs = attrsText(parts);
    const score = scoreInputAgainstHints(attrs, hints);
    if (score > bestScore) {
      bestScore = score;
      best = input;
    }
  }

  // Минимальный порог: иначе «почти ничего» не считаем находкой.
  return bestScore >= 15 ? best : null;
}

async function otpFieldCount(page) {
  return page.locator(OTP_INPUT).count().catch(() => 0);
}

/**
 * Есть ли на странице приглашение войти. Ключевой признак: на публичной
 * (рекламной) странице портала всегда есть кнопка «Log in»/«Sign up», а внутри
 * кабинета её нет. Только по тексту вроде «Ride Booker» судить нельзя — он
 * встречается в рекламе функции на публичной странице.
 */
export async function hasLoginAffordance(page) {
  const fields = await page
    .locator('input[type="password"]:visible, input[type="email"]:visible')
    .count()
    .catch(() => 0);
  if (fields > 0) return true;

  const cta = page
    .locator('button:visible, a:visible, [role="button"]:visible')
    .filter({ hasText: /^\s*(log\s?in|sign\s?in|sign\s?up|get started|войти|регистрац)/i })
    .first();
  return (await cta.count().catch(() => 0)) > 0;
}

async function looksLikeLoggedInShell(page) {
  // Внутри кабинета нет приглашения войти — это надёжнее любого текстового маркера.
  if (await hasLoginAffordance(page)) return false;
  if ((await otpFieldCount(page)) > 0) return false;
  // Экран согласия — тоже ещё не кабинет (у него бывает свой чекбокс).
  if (await isConsentOrBlockingStep(page)) return false;

  // Плюс любой содержательный признак приложения: выход из аккаунта,
  // интерфейс заказа или просто поля ввода (на рекламной странице их нет).
  const count = async (locator) => locator.count().catch(() => 0);

  const logout = page
    .locator('button:visible, a:visible, [role="button"]:visible, nav:visible')
    .filter({ hasText: /log\s?out|sign\s?out|my account|выйти|профил/i })
    .first();
  if ((await count(logout)) > 0) return true;

  const bookingText = page.getByText(/ride booker|book a ride|new ride|dashboard|заказ/i).first();
  if ((await count(bookingText)) > 0) return true;

  // Текстовые поля (адреса), но не служебные чекбоксы экрана согласия.
  const textInputs = page
    .locator('input[type="text"]:visible, input[type="search"]:visible, input:not([type]):visible')
    .first();
  return (await count(textInputs)) > 0;
}

async function isConsentOrBlockingStep(page) {
  const url = page.url();
  if (/\/consent|\/terms|\/privacy|\/gdpr/i.test(url)) return true;

  // Не путать с обычной кнопкой Continue на логине: нужен явный consent-контекст.
  const consentRoot = page
    .locator('body')
    .filter({ hasText: /terms and privacy|privacy consent|terms of service|соглас.*(условия|политик)|условия использования/i });
  if ((await consentRoot.count().catch(() => 0)) === 0) return false;

  const accept = page
    .locator('button:visible, [role="button"]:visible')
    .filter({ hasText: /^(accept|agree|принять|согласен)\b/i })
    .first();
  return (await accept.count().catch(() => 0)) > 0;
}

async function isLoginPage(page) {
  const url = page.url();
  if (/login|signin|sign-in|auth|otp|verify|2fa/i.test(url)) return true;

  const passwordVisible = await page
    .locator('input[type="password"]:visible')
    .count()
    .catch(() => 0);
  if (passwordVisible > 0) return true;

  if ((await otpFieldCount(page)) > 0) return true;

  // Поле email на первом шаге или кнопка «Log in» на публичной странице портала.
  return hasLoginAffordance(page);
}

/**
 * Публичная страница портала: приглашение войти есть, а полей ввода ещё нет.
 * Тогда нужно сначала нажать «Log in», чтобы добраться до самой формы.
 */
async function openLoginFormIfNeeded(page) {
  const fields = await page
    .locator('input[type="password"]:visible, input[type="email"]:visible')
    .count()
    .catch(() => 0);
  if (fields > 0) return;

  if (await clickByText(page, ['log in', 'sign in', 'войти'])) {
    await page
      .locator('input[type="password"]:visible, input[type="email"]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 15000 })
      .catch(() => {});
  }
}

function loginFailureError(kind = 'auth') {
  if (kind === 'consent') {
    return new Error(
      'Вход в Bolt Business требует дополнительного согласия/подтверждения на сайте. ' +
        'Запустите один раз интерактивный вход: `npm run login`, завершите шаги вручную — сессия сохранится.'
    );
  }
  return new Error(
    'Не удалось автоматически войти в Bolt Business (вероятно, требуется код подтверждения/2FA). ' +
      'Запустите один раз интерактивный вход: `npm run login`, завершите вход вручную — сессия сохранится.'
  );
}

/**
 * Выполняет вход по email/паролю. Успех — только при положительном признаке
 * залогиненного кабинета (Ride Booker / dashboard). Отсутствие формы логина
 * само по себе успехом не считается (OTP/consent/загрузка).
 */
export async function performLogin(page, { interactive = false } = {}) {
  await page.goto(config.bolt.portalUrl || config.bolt.baseUrl, {
    waitUntil: 'domcontentloaded',
  });

  // Ждём либо форму логина, либо признаки уже авторизованного кабинета.
  await Promise.race([
    page.locator('input[type="email"]:visible, input[type="password"]:visible').first().waitFor({
      state: 'visible',
      timeout: 10000,
    }),
    page
      .locator('body')
      .getByText(/ride booker|book a ride|dashboard/i)
      .first()
      .waitFor({ state: 'visible', timeout: 10000 }),
  ]).catch(() => {});

  if (await looksLikeLoggedInShell(page)) return true;

  if (!(await isLoginPage(page)) && !(await isConsentOrBlockingStep(page))) {
    // Неясное состояние (ещё грузится / промежуточный экран) — короткое ожидание.
    await page
      .getByText(/ride booker|book a ride|dashboard/i)
      .first()
      .waitFor({ state: 'visible', timeout: 5000 })
      .catch(() => {});
    if (await looksLikeLoggedInShell(page)) return true;
    if (!(await isLoginPage(page)) && !(await isConsentOrBlockingStep(page))) {
      throw loginFailureError('auth');
    }
  }

  if (await isConsentOrBlockingStep(page) && !interactive) {
    throw loginFailureError('consent');
  }

  // На публичной странице портала сначала нужно открыть саму форму входа.
  await openLoginFormIfNeeded(page);

  // Иногда сначала показывается поле email, затем — пароль.
  let emailInput = await findInputByHints(page, ['email', 'e-mail', 'почт']);
  if (!emailInput) {
    const emailLocator = page.locator('input[type="email"]:visible').first();
    if ((await emailLocator.count()) > 0) emailInput = emailLocator;
  }
  if (emailInput) {
    await emailInput.fill(config.bolt.email, { timeout: 8000 });
  }

  // Нажимаем «продолжить», если пароль ещё не показан.
  let passwordInput = page.locator('input[type="password"]:visible').first();
  if ((await passwordInput.count()) === 0) {
    await clickByText(page, ['continue', 'next', 'далее', 'продолжить']);
    await page
      .locator('input[type="password"]:visible')
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});
    passwordInput = page.locator('input[type="password"]:visible').first();
  }

  if ((await passwordInput.count()) > 0) {
    await passwordInput.fill(config.bolt.password, { timeout: 8000 });
    await clickByText(page, ['log in', 'sign in', 'войти', 'continue', 'submit']);
  }

  // Ждём кабинет; OTP/consent в headless — сразу понятная ошибка.
  const deadline = Date.now() + (interactive ? 5 * 60 * 1000 : 12000);
  while (Date.now() < deadline) {
    if (await looksLikeLoggedInShell(page)) return true;

    if ((await otpFieldCount(page)) > 0 && !interactive) {
      throw loginFailureError('auth');
    }
    if ((await isConsentOrBlockingStep(page)) && !interactive) {
      throw loginFailureError('consent');
    }

    await page
      .getByText(/ride booker|book a ride|dashboard/i)
      .first()
      .waitFor({ state: 'visible', timeout: 1500 })
      .catch(() => {});
  }

  if (await looksLikeLoggedInShell(page)) return true;
  if (await isConsentOrBlockingStep(page)) throw loginFailureError('consent');
  throw loginFailureError('auth');
}

function buttonTextPattern(t) {
  const escaped = String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b в JS работает только для ASCII-«слов»; для кириллицы («войти») границы ломаются.
  if (/^[a-z0-9][a-z0-9\s-]*$/i.test(t)) {
    return new RegExp(`\\b${escaped}\\b`, 'i');
  }
  return new RegExp(escaped, 'i');
}

async function clickByText(page, texts) {
  for (const t of texts) {
    const btn = page
      .locator(`button:visible, [role="button"]:visible, a:visible`)
      .filter({ hasText: buttonTextPattern(t) })
      .first();
    if ((await btn.count()) > 0) {
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

async function typeAddress(page, input, value, label) {
  await input.click({ timeout: 5000 });
  await input.fill('');
  await input.type(value, { delay: 35 });

  const suggestion = page.locator('[role="option"]:visible').first();
  try {
    await suggestion.waitFor({ state: 'visible', timeout: 8000 });
    await suggestion.click({ timeout: 5000 });
  } catch {
    throw new Error(
      `Не найдены подсказки адреса для «${label}» («${value}»). ` +
        'Проверьте адрес или изменилась вёрстка автодополнения портала.'
    );
  }
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
 * DOM-фолбэк: читает список тарифов со страницы (узкий набор контейнеров).
 */
async function scrapeDomTariffs(page) {
  return page
    .evaluate(() => {
      const results = [];
      const seen = new Set();
      const priceRe = /(?:€|EUR|\$|£)\s?\d[\d\s.,]*|\d[\d\s.,]*\s?(?:€|EUR|\$|£)/i;
      const roots = Array.from(
        document.querySelectorAll(
          [
            '[data-testid*="categor" i]',
            '[data-testid*="ride" i]',
            '[class*="ride-option" i]',
            '[class*="ride_option" i]',
            '[class*="category" i]',
            '[class*="tariff" i]',
            '[class*="vehicle" i]',
            '.tariff',
            '#tariffs .tariff',
          ].join(', ')
        )
      );

      for (const node of roots) {
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 100) continue;
        if (!priceRe.test(text)) continue;
        const priceMatch = text.match(
          /((?:€|EUR|\$|£)\s?\d[\d\s.,]*|\d[\d\s.,]*\s?(?:€|EUR|\$|£))/i
        );
        const price = priceMatch ? priceMatch[0].trim() : null;
        if (!price) continue;
        let name = text.replace(price, '').replace(/\s+/g, ' ').trim();
        name = name.replace(/^[-–—|:·]+|[-–—|:·]+$/g, '').trim();
        if (!name || name.length < 2 || name.length > 40) continue;
        if (/help|copyright|promo|offer|news|cookie/i.test(name)) continue;
        const key = `${name}|${price}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ name, price, eta: null, surge: null });
      }
      return results;
    })
    .catch(() => []);
}

async function getPricesInternal({ pickup, destination }) {
  if (!pickup || !destination) {
    throw new Error('Нужно указать адреса начала (pickup) и конца (destination).');
  }

  const { browser, context } = await launch({ useSession: true });
  const capture = captureResponses(context);
  const page = await context.newPage();

  try {
    // Успех performLogin = положительный признак кабинета; только тогда пишем сессию.
    await performLogin(page, { interactive: false });
    await saveSession(context);

    // Переходим к инструменту заказа/оценки.
    await page.goto(config.bolt.portalUrl || config.bolt.baseUrl, {
      waitUntil: 'domcontentloaded',
    });
    await clickByText(page, ['ride booker', 'book a ride', 'new ride', 'order', 'заказ']);
    await page
      .locator(
        'input:visible:not([type="hidden"]):not([type="password"]):not([type="email"])'
      )
      .first()
      .waitFor({ state: 'visible', timeout: 12000 })
      .catch(() => {});

    const pickupInput = await findInputByHints(page, PICKUP_HINTS);
    const destInput = await findInputByHints(page, DEST_HINTS, { exclude: pickupInput });
    if (!pickupInput || !destInput) {
      const shot = config.debug ? await dumpDebug(page, capture.payloads, 'no-inputs') : null;
      throw new Error(
        'Не найдены поля адресов на странице заказа. Возможно, изменилась вёрстка портала. ' +
          (shot ? `Скриншот: ${shot}` : 'Включите DEBUG_CAPTURE=1 для скриншота.')
      );
    }

    // Сбрасываем всё, что успели поймать на логине/дашборде — иначе extractTariffs
    // подхватит виджеты с name/price и выдаст фейковые тарифы.
    capture.clear();

    const priceResponseWait = page
      .waitForResponse(
        (r) => {
          try {
            const url = r.url();
            return (
              isBoltApi(url) &&
              /ride|estimate|price|fare|categor|quote|search/i.test(url) &&
              isJsonResponse(r)
            );
          } catch {
            return false;
          }
        },
        { timeout: Math.min(config.browser.timeoutMs, 20000) }
      )
      .catch(() => null);

    await typeAddress(page, pickupInput, pickup, 'pickup');
    await typeAddress(page, destInput, destination, 'destination');

    await priceResponseWait;
    // Даем догрузить возможные дополнительные JSON-ответы с категориями.
    await new Promise((r) => setTimeout(r, 600));

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

/**
 * Основной метод: возвращает актуальные тарифы Bolt для маршрута.
 * @param {{pickup:string, destination:string}} params
 */
export async function getPrices(params) {
  const ms = config.browser.requestTimeoutMs;
  return withTimeout(
    getPricesInternal(params),
    ms,
    `Превышен общий таймаут запроса цен (${ms} мс). Повторите позже или увеличьте REQUEST_TIMEOUT_MS.`
  );
}

function guessCurrency(tariffs) {
  for (const t of tariffs) {
    if (!t.price) continue;
    const m = t.price.match(/€|EUR|\$|£|USD|GBP/i);
    if (m) return m[0];
  }
  return null;
}

export { hasSession, findInputByHints, scoreInputAgainstHints };
