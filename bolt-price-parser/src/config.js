import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const config = {
  rootDir,
  port: Number(process.env.PORT || 4000),

  // Учётные данные Bolt Business (business.bolt.eu). НИКОГДА не хардкодим — только через .env.
  bolt: {
    email: process.env.BOLT_EMAIL || '',
    password: process.env.BOLT_PASSWORD || '',
    baseUrl: process.env.BOLT_BASE_URL || 'https://business.bolt.eu',
    // Город/страна по умолчанию — для подсказок адресов.
    defaultCity: process.env.BOLT_DEFAULT_CITY || 'Rīga',
    defaultCountry: process.env.BOLT_DEFAULT_COUNTRY || 'Latvia',
  },

  browser: {
    // headless для сервера; headed нужен для первичного логина (login.js).
    headless: bool(process.env.HEADLESS, true),
    // Файл, где хранится сессия (cookies + localStorage) после логина.
    storageStatePath:
      process.env.STORAGE_STATE_PATH || path.join(rootDir, '.session', 'storageState.json'),
    // Папка для отладочных скриншотов/дампов.
    debugDir: process.env.DEBUG_DIR || path.join(rootDir, '.debug'),
    slowMo: Number(process.env.SLOW_MO || 0),
    timeoutMs: Number(process.env.NAV_TIMEOUT_MS || 45000),
    locale: process.env.BROWSER_LOCALE || 'en-US',
    // Координаты по умолчанию (центр Риги) — часть сайтов требует геолокацию.
    geo: {
      latitude: Number(process.env.GEO_LAT || 56.9496),
      longitude: Number(process.env.GEO_LNG || 24.1052),
    },
  },

  // Сохранять ли отладочные артефакты (скриншот + захваченный JSON) при каждом запросе.
  debug: bool(process.env.DEBUG_CAPTURE, false),
};

export function assertCredentials() {
  if (!config.bolt.email || !config.bolt.password) {
    throw new Error(
      'Не заданы BOLT_EMAIL / BOLT_PASSWORD. Скопируйте .env.example в .env и заполните доступы.'
    );
  }
}
