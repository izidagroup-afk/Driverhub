/**
 * Интерактивный вход в Bolt Business для сохранения сессии.
 *
 * Запуск: `npm run login`
 * По умолчанию всегда открывается видимое окно браузера (headed), даже если в
 * `.env` стоит HEADLESS=true — иначе нельзя ввести OTP/2FA.
 *
 * Headless только при явном opt-in:
 *   npm run login -- --headless
 *   LOGIN_HEADLESS=1 npm run login
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertCredentials } from './config.js';
import { launch, saveSession } from './browser.js';
import { performLogin } from './boltBusiness.js';

/**
 * Решает, запускать ли login headless.
 * Игнорирует HEADLESS из .env — только явный CLI-флаг или LOGIN_HEADLESS.
 */
export function resolveLoginHeadless({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  if (argv.includes('--headless')) return true;
  const flag = String(env.LOGIN_HEADLESS || '').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(flag);
}

async function main() {
  assertCredentials();

  const headless = resolveLoginHeadless();
  if (headless) {
    console.warn(
      '\n[!] Login запущен в headless (`--headless` или LOGIN_HEADLESS=1). ' +
        'Код подтверждения ввести будет нельзя. Для обычного входа: `npm run login`.\n'
    );
  } else {
    console.log('\nОткрываю браузер для интерактивного входа (headed).');
    console.log('HEADLESS из .env на эту команду не влияет.\n');
  }

  const { browser, context } = await launch({ headless, useSession: true });
  const page = await context.newPage();

  console.log(`Открываю ${config.bolt.baseUrl} … Войдите в аккаунт в открывшемся окне.`);
  try {
    // interactive=true только в headed: там пользователь может ввести OTP вручную.
    await performLogin(page, { interactive: !headless });
    // performLogin возвращает успех только при положительном признаке кабинета.
    await saveSession(context);
    console.log(`\n[✓] Сессия сохранена: ${config.browser.storageStatePath}`);
    console.log('Теперь можно запускать сервер: npm start');
  } catch (err) {
    console.error('\n[x] Не удалось сохранить сессию:', err.message);
    process.exitCode = 1;
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
