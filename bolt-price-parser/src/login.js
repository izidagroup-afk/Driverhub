/**
 * Интерактивный вход в Bolt Business для сохранения сессии.
 *
 * Запуск: `npm run login`
 * По умолчанию всегда открывается видимое окно браузера (headed), даже если в
 * `.env` стоит HEADLESS=true — иначе нельзя ввести OTP/2FA.
 *
 * Скрипт не пытается угадать момент успешного входа: вы завершаете вход руками
 * и подтверждаете это нажатием Enter в терминале. Сессия сохраняется только
 * после проверки, что в окне действительно открыт кабинет, а не форма входа.
 *
 * Headless только при явном opt-in:
 *   npm run login -- --headless
 *   LOGIN_HEADLESS=1 npm run login
 */
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config, assertCredentials } from './config.js';
import { launch, saveSession } from './browser.js';
import { performLogin, hasLoginAffordance } from './boltBusiness.js';

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

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
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

  try {
    // Best-effort автозаполнение: если не сработает — просто входите руками.
    await performLogin(page, { interactive: true }).catch(() => {});

    if (!headless) {
      console.log('\n──────────────────────────────────────────────────────────');
      console.log('Завершите вход в открывшемся окне браузера:');
      console.log('  1) email и пароль (могли подставиться автоматически);');
      console.log('  2) код подтверждения из письма/СМС, если запросят.');
      console.log('Когда на экране будет ваш кабинет Bolt Business —');
      console.log('вернитесь сюда и нажмите Enter.');
      console.log('──────────────────────────────────────────────────────────\n');
      await waitForEnter('Нажмите Enter, когда вход завершён… ');
    }

    if (await hasLoginAffordance(page)) {
      console.error(
        '\n[x] В окне браузера всё ещё видна форма входа (или кнопка «Log in»).\n' +
          '    Сессия НЕ сохранена, чтобы не записать пустой вход.\n' +
          '    Войдите до конца и запустите `npm run login` ещё раз.'
      );
      process.exitCode = 1;
      return;
    }

    await saveSession(context);
    console.log(`\n[✓] Сессия сохранена: ${config.browser.storageStatePath}`);

    const currentUrl = page.url();
    console.log(`\n[i] Адрес вашего кабинета: ${currentUrl}`);
    console.log('    Впишите его в .env как BOLT_PORTAL_URL — тогда сервер будет');
    console.log('    открывать сразу кабинет, а не публичную страницу портала:');
    console.log(`    BOLT_PORTAL_URL=${currentUrl}`);
    console.log('\nТеперь можно запускать сервер: npm start');
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
