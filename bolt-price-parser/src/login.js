/**
 * Интерактивный вход в Bolt Business для сохранения сессии.
 *
 * Запуск: `HEADLESS=false npm run login`
 * Откроется браузер. Войдите (email/пароль + код из письма/СМС, если попросит).
 * После успешного входа сессия сохранится в .session/storageState.json,
 * и сервер будет переиспользовать её без повторного логина.
 */
import { config, assertCredentials } from './config.js';
import { launch, saveSession } from './browser.js';
import { performLogin } from './boltBusiness.js';

async function main() {
  assertCredentials();

  const headless = process.env.HEADLESS ? config.browser.headless : false;
  if (headless) {
    console.warn(
      '\n[!] Похоже, HEADLESS=true. Для ручного входа лучше запустить с HEADLESS=false, ' +
        'чтобы видеть окно браузера и ввести код подтверждения.\n'
    );
  }

  const { browser, context } = await launch({ headless, useSession: true });
  const page = await context.newPage();

  console.log(`Открываю ${config.bolt.baseUrl} … Войдите в аккаунт в открывшемся окне.`);
  try {
    await performLogin(page, { interactive: true });
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

main();
