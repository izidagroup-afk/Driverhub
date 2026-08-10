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
  // По умолчанию только localhost — не светим портал/сессию в сеть.
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 4000),

  // Опциональный общий токен для POST /api/prices. Пусто = без проверки (ок на localhost).
  apiToken: process.env.API_TOKEN || '',

  // Простой per-IP лимит на /api/prices (без внешних зависимостей).
  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 20),
  },

  // Учётные данные Bolt Business (business.bolt.eu). НИКОГДА не хардкодим — только через .env.
  bolt: {
    email: process.env.BOLT_EMAIL || '',
    password: process.env.BOLT_PASSWORD || '',
    baseUrl: process.env.BOLT_BASE_URL || 'https://business.bolt.eu',
    // Адрес самого кабинета (после входа). На business.bolt.eu корень — рекламная
    // страница, поэтому цены запрашиваются по этому URL. Заполняется из адресной
    // строки браузера после первого входа (`npm run login` подскажет значение).
    portalUrl: process.env.BOLT_PORTAL_URL || '',
    // Город/страна по умолчанию — для подсказок адресов.
    defaultCity: process.env.BOLT_DEFAULT_CITY || 'Rīga',
    defaultCountry: process.env.BOLT_DEFAULT_COUNTRY || 'Latvia',
  },

  // Источник цен: 'web' — веб-портал Bolt Business через браузер,
  // 'mobile' — эмуляция мобильного приложения (вход по телефону + СМС),
  // 'auto' — mobile, если есть сессия приложения, иначе web.
  provider: (process.env.PROVIDER || 'auto').toLowerCase(),

  mobile: {
    // Телефон в международном формате, например +371XXXXXXXX.
    phone: process.env.BOLT_PHONE || '',
    baseUrl: process.env.BOLT_MOBILE_BASE_URL || 'https://user.live.boltsvc.net',
    // Поиск тарифов исторически живёт на отдельном хосте.
    searchBaseUrl: process.env.BOLT_SEARCH_BASE_URL || 'https://search.bolt.eu',
    // Готовый токен, если он уже добыт (перехват трафика приложения).
    accessToken: process.env.BOLT_ACCESS_TOKEN || '',
    // Файл с токеном и идентификатором «устройства».
    sessionPath:
      process.env.MOBILE_SESSION_PATH || path.join(rootDir, '.session', 'mobile.json'),
    deviceType: process.env.BOLT_DEVICE_TYPE || 'android',
    appVersion: process.env.BOLT_APP_VERSION || 'CA.218.0',
    deviceName: process.env.BOLT_DEVICE_NAME || 'Google Pixel 7',
    deviceOsVersion: process.env.BOLT_DEVICE_OS_VERSION || '13',
    language: process.env.BOLT_LANGUAGE || 'ru',
    country: process.env.BOLT_COUNTRY || 'lv',
  },

  browser: {
    // headless для сервера; login.js всегда headed, пока явно не opt-in.
    headless: bool(process.env.HEADLESS, true),
    // Файл, где хранится сессия (cookies + localStorage) после логина.
    storageStatePath:
      process.env.STORAGE_STATE_PATH || path.join(rootDir, '.session', 'storageState.json'),
    // Папка для отладочных скриншотов/дампов.
    debugDir: process.env.DEBUG_DIR || path.join(rootDir, '.debug'),
    slowMo: Number(process.env.SLOW_MO || 0),
    timeoutMs: Number(process.env.NAV_TIMEOUT_MS || 45000),
    // Жёсткий потолок на один запрос цен (логин + адреса + сеть).
    requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 90000),
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
