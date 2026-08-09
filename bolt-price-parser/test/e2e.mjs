/**
 * E2E: реальный scraper (Playwright) против локального mock-портала.
 *
 * Запуск: npm run test:e2e
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startMockPortal } from './mock-portal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const artifactsDir = path.join(rootDir, '.test-artifacts');
const storageStatePath = path.join(artifactsDir, 'storageState.json');
const debugDir = path.join(artifactsDir, 'debug');

const MOCK_EMAIL = 'test@example.com';
const MOCK_PASSWORD = 'test-password';

let passed = 0;
let failed = 0;
const failures = [];

function log(msg) {
  console.log(msg);
}

async function test(name, fn) {
  process.stdout.write(`  • ${name} … `);
  try {
    await fn();
    passed += 1;
    console.log('OK');
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log('FAIL');
    console.log(`      ${err && err.stack ? err.stack : err}`);
  }
}

function rmSafe(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function ensureArtifacts() {
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.mkdirSync(debugDir, { recursive: true });
}

function clearSession() {
  rmSafe(storageStatePath);
}

async function main() {
  ensureArtifacts();
  clearSession();

  const mock = await startMockPortal(0, {
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    priceMode: 'ok',
    autocompleteDelayMs: 200,
  });

  // Env ДО динамического импорта config/boltBusiness (dotenv не перезапишет уже заданные).
  process.env.BOLT_EMAIL = MOCK_EMAIL;
  process.env.BOLT_PASSWORD = MOCK_PASSWORD;
  process.env.BOLT_BASE_URL = mock.baseUrl;
  process.env.STORAGE_STATE_PATH = storageStatePath;
  process.env.DEBUG_DIR = debugDir;
  process.env.DEBUG_CAPTURE = '0';
  process.env.HEADLESS = 'true';
  process.env.NAV_TIMEOUT_MS = '30000';
  process.env.REQUEST_TIMEOUT_MS = '60000';
  process.env.BOLT_DEFAULT_CITY = 'Rīga';
  // Не поднимаем основной сервер на 4000 при импорте.
  process.env.PORT = '0';
  process.env.HOST = '127.0.0.1';

  const { extractTariffs } = await import('../src/priceExtractor.js');
  const { scoreInputAgainstHints, getPrices, hasSession } = await import('../src/boltBusiness.js');
  const { createApp } = await import('../src/server.js');
  const { config } = await import('../src/config.js');
  const { resolveLoginHeadless } = await import('../src/login.js');

  assert.equal(config.bolt.baseUrl, mock.baseUrl, 'BOLT_BASE_URL должен указывать на mock');
  assert.equal(config.host, '127.0.0.1');

  log('\n=== Unit: priceExtractor / input scoring / login headless ===\n');

  await test('resolveLoginHeadless: игнорирует HEADLESS из .env', () => {
    assert.equal(
      resolveLoginHeadless({ argv: [], env: { HEADLESS: 'true' } }),
      false,
      'HEADLESS=true не должен включать headless для login'
    );
    assert.equal(
      resolveLoginHeadless({ argv: ['--headless'], env: { HEADLESS: 'false' } }),
      true
    );
    assert.equal(
      resolveLoginHeadless({ argv: [], env: { LOGIN_HEADLESS: '1', HEADLESS: 'false' } }),
      true
    );
  });

  await test('extractTariffs: реалистичный nested payload', () => {
    const payloads = [
      {
        data: {
          ride_options: {
            categories: [
              {
                category_id: 'bolt',
                category_name: 'Bolt',
                price_str: '€12.50',
                eta_str: '3 min',
                surge_multiplier: 1,
              },
              {
                category_name: 'Bolt Electric',
                price_str: '€13.10',
                surge_multiplier: 1,
              },
              {
                categoryId: 'xl',
                display_name: 'XL',
                price: { amount: 18.9, currency: 'EUR' },
                surgeMultiplier: 1.2,
              },
            ],
          },
        },
        notifications: [{ id: 'n1', name: 'Promo', price: '€5', title: 'Discount' }],
      },
    ];
    const tariffs = extractTariffs(payloads);
    assert.equal(tariffs.length, 3, `ожидали 3 тарифа, получили ${tariffs.length}: ${JSON.stringify(tariffs)}`);
    assert.ok(tariffs.some((t) => t.name === 'Bolt' && t.price.includes('12.50')));
    assert.ok(tariffs.some((t) => t.name === 'Bolt Electric'));
    assert.ok(tariffs.some((t) => t.name === 'XL' && /18\.9/.test(t.price)));
    assert.ok(!tariffs.some((t) => /promo/i.test(t.name)));
  });

  await test('extractTariffs: не берёт виджеты дашборда с голым id', () => {
    const tariffs = extractTariffs([
      {
        widgets: [
          { id: 'promo1', name: 'Summer promo', price: '€5', title: 'Discount' },
          { id: 'stat1', name: 'Trips this month', price: 42 },
        ],
      },
    ]);
    assert.equal(tariffs.length, 0, JSON.stringify(tariffs));
  });

  await test('scoreInputAgainstHints: «to» не матчит autocomplete', () => {
    assert.equal(scoreInputAgainstHints('autocomplete', ['to']), 0);
    assert.ok(scoreInputAgainstHints('destination address', DEST_HINTS_LOCAL()) > 0);
    assert.ok(scoreInputAgainstHints('pickup address', ['pickup', 'from']) > scoreInputAgainstHints('destination address', ['pickup', 'from']));
    assert.ok(scoreInputAgainstHints('where to', ['to']) > 0);
    assert.equal(scoreInputAgainstHints('information', ['from']), 0);
  });

  function DEST_HINTS_LOCAL() {
    return ['destination address', 'destination', 'to'];
  }

  log('\n=== E2E: happy path against mock portal ===\n');

  await test('getPrices: полный цикл логин → адреса → тарифы', async () => {
    clearSession();
    mock.setConfig({
      requireOtp: false,
      noAddressInputs: false,
      noAutocomplete: false,
      priceMode: 'ok',
      sessionVersion: 1,
    });

    const result = await getPrices({
      pickup: 'Brīvības iela 1',
      destination: 'Lidosta Rīga',
    });

    assert.equal(result.pickup, 'Brīvības iela 1');
    assert.equal(result.destination, 'Lidosta Rīga');
    assert.equal(result.source, 'bolt-business-web');
    assert.ok(Array.isArray(result.tariffs));
    assert.ok(result.tariffs.length >= 3, `tariffs=${JSON.stringify(result.tariffs)}`);
    const names = result.tariffs.map((t) => t.name);
    assert.ok(names.includes('Bolt'), names.join(','));
    assert.ok(names.includes('Comfort') || names.includes('XL') || names.includes('Bolt Electric'), names.join(','));
    assert.ok(!names.some((n) => /promo|summer|trips/i.test(n)), 'не должно быть мусора с дашборда');
    assert.ok(hasSession(), 'сессия должна сохраниться');
  });

  await test('POST /api/prices через Express: те же тарифы', async () => {
    mock.setConfig({ priceMode: 'ok', noAutocomplete: false, noAddressInputs: false });
    const app = createApp();
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pickup: 'Elizabetes iela 2',
          destination: 'Central Market',
        }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const data = await res.json();
      assert.ok(data.tariffs.length >= 3, JSON.stringify(data.tariffs));
      assert.ok(data.elapsedMs > 0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  log('\n=== E2E: failure paths ===\n');

  await test('нет/протухшая сессия: релогин и успешный ответ', async () => {
    // Сессия уже есть с прошлого теста — инвалидируем cookie на mock.
    assert.ok(hasSession());
    mock.invalidateSessions();
    mock.setConfig({ requireOtp: false, priceMode: 'ok', noAutocomplete: false });

    const result = await getPrices({
      pickup: 'Alberta iela 1',
      destination: 'Vecrīga',
    });
    assert.ok(result.tariffs.length >= 3, JSON.stringify(result.tariffs));
  });

  function writeSentinelSession(value) {
    const sentinel = JSON.stringify({
      cookies: [
        {
          name: 'sentinel',
          value,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
    fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
    fs.writeFileSync(storageStatePath, sentinel);
    return sentinel;
  }

  await test('OTP в headless: fail + сессия не сохраняется/не портится', async () => {
    const sentinel = writeSentinelSession('keep-me');
    mock.setConfig({ requireOtp: true, requireConsent: false });
    try {
      const t0 = Date.now();
      await assert.rejects(
        () => getPrices({ pickup: 'A', destination: 'B' }),
        (err) => {
          assert.match(String(err.message), /npm run login/i);
          return true;
        }
      );
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 25000, `должен fail-fast, а не висеть: ${elapsed}ms`);
      assert.equal(
        fs.readFileSync(storageStatePath, 'utf8'),
        sentinel,
        'частичный OTP-стейт не должен перезаписывать storageState'
      );
    } finally {
      mock.setConfig({ requireOtp: false, requireConsent: false });
      clearSession();
    }
  });

  await test('consent step: fail + сессия не сохраняется/не портится', async () => {
    const sentinel = writeSentinelSession('consent-keep');
    mock.setConfig({ requireConsent: true, requireOtp: false });
    try {
      await assert.rejects(
        () => getPrices({ pickup: 'A', destination: 'B' }),
        (err) => {
          assert.match(String(err.message), /согласия|подтверждения|npm run login/i);
          return true;
        }
      );
      assert.equal(
        fs.readFileSync(storageStatePath, 'utf8'),
        sentinel,
        'consent-стейт не должен перезаписывать storageState'
      );
    } finally {
      mock.setConfig({ requireConsent: false, requireOtp: false });
      clearSession();
    }
  });

  await test('поля адресов не найдены: понятная ошибка', async () => {
    clearSession();
    mock.setConfig({ noAddressInputs: true, requireOtp: false });
    await assert.rejects(
      () => getPrices({ pickup: 'A street', destination: 'B street' }),
      (err) => {
        assert.match(String(err.message), /Не найдены поля адресов|вёрстка/i);
        return true;
      }
    );
    mock.setConfig({ noAddressInputs: false });
  });

  await test('автодополнение пустое: понятная ошибка, без зависания', async () => {
    clearSession();
    mock.setConfig({ noAutocomplete: true, requireOtp: false, noAddressInputs: false });
    const t0 = Date.now();
    await assert.rejects(
      () => getPrices({ pickup: 'Nowhere', destination: 'Also nowhere' }),
      (err) => {
        assert.match(String(err.message), /подсказки адреса/i);
        return true;
      }
    );
    assert.ok(Date.now() - t0 < 40000, 'не должен висеть слишком долго');
    mock.setConfig({ noAutocomplete: false });
  });

  await test('price API error / empty / badSchema: без падения, пустые или DOM', async () => {
    for (const mode of ['error', 'empty', 'badSchema']) {
      clearSession();
      mock.setConfig({ priceMode: mode, noAutocomplete: false, noAddressInputs: false, requireOtp: false });
      const result = await getPrices({
        pickup: 'Test street 1',
        destination: 'Test street 2',
      });
      assert.ok(Array.isArray(result.tariffs), `mode=${mode}`);
      // error/empty/badSchema не дают валидных JSON-тарифов; DOM тоже пуст или без цен.
      assert.equal(
        result.tariffs.length,
        0,
        `mode=${mode} неожиданные тарифы: ${JSON.stringify(result.tariffs)}`
      );
    }
    mock.setConfig({ priceMode: 'ok' });
  });

  await test('POST /api/prices: невалидное тело → 400', async () => {
    const app = createApp();
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const cases = [
        { raw: 'null' },
        { raw: '{}' },
        { raw: '{"pickup":"x"}' },
        { raw: '{"destination":"y"}' },
        { raw: '{"pickup":"","destination":""}' },
        { raw: '{' }, // битый JSON
      ];
      for (const c of cases) {
        const res = await fetch(`http://127.0.0.1:${port}/api/prices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: c.raw,
        });
        assert.equal(res.status, 400, `body=${c.raw} status=${res.status}`);
        const data = await res.json();
        assert.match(data.error, /pickup|destination/i);
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('POST /api/prices: concurrent → 429 busy lock', async () => {
    clearSession();
    mock.setConfig({
      priceMode: 'ok',
      noAutocomplete: false,
      noAddressInputs: false,
      requireOtp: false,
      autocompleteDelayMs: 400,
    });

    const app = createApp();
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();

    const body = JSON.stringify({
      pickup: 'Concurrent A',
      destination: 'Concurrent B',
    });

    try {
      const p1 = fetch(`http://127.0.0.1:${port}/api/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      // Даем первому запросу захватить busy.
      await new Promise((r) => setTimeout(r, 300));
      const p2 = fetch(`http://127.0.0.1:${port}/api/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      const statuses = [r1.status, r2.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 429], `statuses=${statuses}`);
      const busyRes = r1.status === 429 ? r1 : r2;
      const busyJson = await busyRes.json();
      assert.match(busyJson.error, /другой запрос|Подождите/i);

      // Дождаться завершения первого, чтобы busy сбросился.
      if (r1.status === 200) await r1.json();
      else await r2.json();
    } finally {
      await new Promise((r) => server.close(r));
      mock.setConfig({ autocompleteDelayMs: 200 });
    }
  });

  await test('GET /api/health smoke', async () => {
    const app = createApp();
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.credentialsConfigured, true);
      assert.equal(data.city, 'Rīga');
      assert.equal(data.authRequired, false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('API_TOKEN: 401 без токена, 200/502 с токеном; UI config отдаёт token', async () => {
    const app = createApp({ apiToken: 'test-secret-token', rateLimitMax: 100 });
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
      assert.equal(health.authRequired, true);

      const cfgRes = await fetch(`http://127.0.0.1:${port}/app-config.js`);
      assert.equal(cfgRes.status, 200);
      const cfgText = await cfgRes.text();
      assert.match(cfgText, /test-secret-token/);

      const denied = await fetch(`http://127.0.0.1:${port}/api/prices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pickup: 'A', destination: 'B' }),
      });
      assert.equal(denied.status, 401);

      // С токеном проходит auth; тело валидное — дальше может быть 200/502 от scrapera.
      clearSession();
      mock.setConfig({
        requireOtp: false,
        requireConsent: false,
        noAutocomplete: false,
        noAddressInputs: false,
        priceMode: 'ok',
      });
      const okAuth = await fetch(`http://127.0.0.1:${port}/api/prices`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-secret-token',
        },
        body: JSON.stringify({ pickup: 'Token Street 1', destination: 'Token Street 2' }),
      });
      assert.ok([200, 502].includes(okAuth.status), `status=${okAuth.status}`);
      if (okAuth.status === 200) {
        const data = await okAuth.json();
        assert.ok(Array.isArray(data.tariffs));
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await test('per-IP rate limit на /api/prices', async () => {
    const app = createApp({ apiToken: '', rateLimitMax: 3, rateLimitWindowMs: 60_000 });
    const server = createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/prices`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        statuses.push(res.status);
      }
      assert.ok(statuses.filter((s) => s === 400).length >= 3, `statuses=${statuses}`);
      assert.ok(statuses.includes(429), `ожидали 429, получили ${statuses}`);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  await mock.close();

  log('\n=== Summary ===');
  log(`Passed: ${passed}`);
  log(`Failed: ${failed}`);
  if (failures.length) {
    log('\nFailures:');
    for (const f of failures) {
      log(`- ${f.name}: ${f.err.message}`);
    }
    process.exitCode = 1;
  } else {
    log('All tests passed.');
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exitCode = 1;
});
