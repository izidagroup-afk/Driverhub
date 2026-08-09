/**
 * Вход как в мобильном приложении: номер телефона → код из СМС → токен.
 *
 * Запуск: npm run login:mobile
 *
 * Внимание: Bolt держит одну активную сессию на аккаунт — вход «новым
 * устройством» может разлогинить приложение на вашем телефоне.
 */
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { startVerification, confirmVerification } from './mobile/auth.js';
import { loadMobileSession } from './mobile/session.js';

async function main() {
  const rl = readline.createInterface({ input, output });

  try {
    console.log('\nВход в Bolt как мобильное приложение.');
    console.log('Bolt пришлёт код в СМС на номер вашего аккаунта.\n');
    console.log(
      '[!] Учтите: Bolt держит одну активную сессию на аккаунт — приложение\n' +
        '    на телефоне может разлогиниться.\n'
    );

    const saved = loadMobileSession();
    const defaultPhone = config.mobile.phone || saved?.phone || '';
    const phone =
      (await rl.question(
        `Номер телефона в международном формате${defaultPhone ? ` [${defaultPhone}]` : ' (например +37120000000)'}: `
      )) || defaultPhone;

    console.log('\nЗапрашиваю код…');
    await startVerification(phone);
    console.log('[✓] Запрос отправлен. Проверьте СМС.');

    const code = await rl.question('\nВведите код из СМС: ');
    const tokens = await confirmVerification(code);

    console.log(`\n[✓] Вход выполнен${tokens.firstName ? `, ${tokens.firstName}` : ''}.`);
    console.log(`[✓] Сессия сохранена: ${config.mobile.sessionPath}`);
    console.log('\nВключите мобильный источник в .env:');
    console.log('    PROVIDER=mobile');
    console.log('\nЗатем запускайте сервер: npm start');
  } catch (err) {
    console.error('\n[x] Не удалось войти:', err.message);
    console.error(
      '\nЭто приватный API без публичной документации — возможно, Bolt изменил контракт.\n' +
        'Поставьте DEBUG_CAPTURE=1 в .env и повторите: полный ответ сохранится\n' +
        `в ${config.browser.debugDir} — по нему можно быстро поправить запрос.`
    );
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  main();
}
