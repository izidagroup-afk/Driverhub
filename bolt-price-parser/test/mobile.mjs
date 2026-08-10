/**
 * Тесты мобильного источника: вход по СМС и разбор тарифов.
 * Запуск: npm run test:mobile
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startMockMobileApi } from './mock-mobile-api.js';

const sessionPath = path.resolve('.test-artifacts', 'mobile-session.json');

process.env.MOBILE_SESSION_PATH = sessionPath;
process.env.BOLT_DEFAULT_CITY = 'Rīga';
process.env.BOLT_DEFAULT_COUNTRY = 'Latvia';

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  process.stdout.write(`  • ${name} … `);
  try {
    await fn();
    console.log('OK');
    passed++;
  } catch (err) {
    console.log('FAIL');
    console.log(`      ${err.stack || err.message}`);
    failed++;
    failures.push(`${name}: ${err.message}`);
  }
}

function clearSession() {
  if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath);
}

async function main() {
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  clearSession();

  const mock = await startMockMobileApi(0);
  process.env.BOLT_MOBILE_BASE_URL = mock.baseUrl;
  process.env.BOLT_SEARCH_BASE_URL = mock.baseUrl;

  // Импортируем после установки переменных окружения: config читает env при загрузке.
  const { startVerification, confirmVerification } = await import('../src/mobile/auth.js');
  const { findRideOptions, parseRideOptions, parseMeta } = await import('../src/mobile/prices.js');
  const { hasMobileSession, loadMobileSession } = await import('../src/mobile/session.js');

  try {
    console.log('\n=== Мобильный источник: вход по СМС ===\n');

    await test('неверный формат телефона отклоняется до сети', async () => {
      await assert.rejects(() => startVerification('20000000'), /международном формате/i);
    });

    await test('запрос кода: успешный старт верификации', async () => {
      const res = await startVerification('+37120000000');
      assert.equal(res.phone, '+37120000000');
      const session = loadMobileSession();
      assert.ok(session.phoneUuid, 'phone_uuid должен сохраниться между шагами');
    });

    await test('неверный код: понятная ошибка от Bolt', async () => {
      await assert.rejects(() => confirmVerification('0000'), /INVALID_VERIFICATION_CODE/);
    });

    await test('верный код: токен сохраняется', async () => {
      const tokens = await confirmVerification('1234');
      assert.equal(tokens.accessToken, 'access_mock_token');
      assert.equal(tokens.refreshToken, 'refresh_mock_token');
      assert.ok(hasMobileSession());
    });

    await test('перебор путей: работает и без суффикса версии', async () => {
      clearSession();
      mock.setConfig({ startPathStyle: 'plain', confirmPathStyle: 'plain' });
      await startVerification('+37120000000');
      const tokens = await confirmVerification('1234');
      assert.ok(tokens.accessToken);
      mock.setConfig({ startPathStyle: 'v2', confirmPathStyle: 'v3' });
    });

    console.log('\n=== Мобильный источник: тарифы ===\n');

    await test('findRideOptions: все тарифы, ETA в минутах, surge', async () => {
      mock.setConfig({ searchMode: 'ok' });
      const payload = await findRideOptions(
        { lat: 56.9577, lng: 24.1241 },
        { lat: 56.9235, lng: 23.9723 }
      );
      const tariffs = parseRideOptions(payload);
      assert.equal(tariffs.length, 3, JSON.stringify(tariffs));

      const bolt = tariffs.find((t) => t.name === 'Bolt');
      assert.equal(bolt.price, '8.50 €');
      assert.equal(bolt.eta, '3 мин', 'секунды должны стать минутами');
      assert.equal(bolt.surge, 1);

      const comfort = tariffs.find((t) => t.name === 'Comfort');
      assert.equal(comfort.surge, 1.3, 'множитель спроса должен извлекаться');

      const meta = parseMeta(payload);
      assert.equal(meta.city, 'Rīga');
      assert.ok(meta.searchToken);
    });

    await test('протухший токен: понятная ошибка авторизации', async () => {
      mock.setConfig({ searchMode: 'unauthorized' });
      await assert.rejects(
        () => findRideOptions({ lat: 56.9, lng: 24.1 }, { lat: 56.92, lng: 23.97 }),
        /USER_NOT_AUTHORIZED|401/
      );
      mock.setConfig({ searchMode: 'ok' });
    });

    await test('прикладная ошибка Bolt не роняет клиент', async () => {
      mock.setConfig({ searchMode: 'error' });
      await assert.rejects(
        () => findRideOptions({ lat: 56.9, lng: 24.1 }, { lat: 56.92, lng: 23.97 }),
        /PRICE_LOCK_NOT_FOUND/
      );
      mock.setConfig({ searchMode: 'ok' });
    });

    await test('parseRideOptions: неожиданная схема → пустой список, без падения', () => {
      assert.deepEqual(parseRideOptions({ data: { widgets: [] } }), []);
      assert.deepEqual(parseRideOptions(null), []);
    });
  } finally {
    await mock.close();
    clearSession();
  }

  console.log('\n=== Итог ===\n');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length) {
    console.log('\nОшибки:');
    for (const f of failures) console.log(`- ${f}`);
    process.exitCode = 1;
  } else {
    console.log('Все тесты прошли.');
  }
}

main();
