/**
 * HTTP-клиент, имитирующий мобильное приложение Bolt.
 *
 * Приложение добавляет к КАЖДОМУ запросу набор одинаковых query-параметров
 * (устройство, город, версия, координаты) — без них бэкенд отвечает ошибкой.
 * Состав параметров подтверждён перехватом трафика Android-приложения.
 *
 * Внимание: контракт приватный и не документирован. Пути авторизации известны
 * только по именам, поэтому запросы отправляются по нескольким кандидатам, а
 * ответы сохраняются для диагностики.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { loadMobileSession, getOrCreateDeviceId } from './session.js';

const USER_AGENT = process.env.BOLT_USER_AGENT || 'okhttp/4.11.0';

/** Общие query-параметры, которые приложение шлёт с каждым запросом. */
export function commonParams(overrides = {}) {
  const session = loadMobileSession() || {};
  const deviceId = getOrCreateDeviceId();
  const userId = session.userId || '';

  return {
    version: config.mobile.appVersion,
    deviceId,
    deviceType: config.mobile.deviceType,
    device_name: config.mobile.deviceName,
    device_os_version: config.mobile.deviceOsVersion,
    country: config.mobile.country,
    language: config.mobile.language,
    gps_lat: String(config.browser.geo.latitude),
    gps_lng: String(config.browser.geo.longitude),
    gps_accuracy_m: '10',
    session_id: session.sessionId || `${userId}${Date.now()}`,
    ...(userId ? { user_id: String(userId) } : {}),
    ...overrides,
  };
}

function authHeader() {
  const session = loadMobileSession() || {};
  const token = config.mobile.accessToken || session.accessToken || session.authToken;
  if (token) return { Authorization: `Bearer ${token}` };

  // Исторический вариант приложения: Basic base64(user_id:token).
  if (session.userId && session.refreshToken) {
    const basic = Buffer.from(`${session.userId}:${session.refreshToken}`).toString('base64');
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}

function dumpDebug(name, payload) {
  if (!config.debug) return;
  try {
    const dir = config.browser.debugDir;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(
      path.join(dir, `mobile-${name}-${stamp}.json`),
      JSON.stringify(payload, null, 2)
    );
  } catch {
    /* диагностика не должна ронять запрос */
  }
}

/**
 * Один POST-запрос к приватному API.
 * @returns {Promise<{ok:boolean, status:number, body:any, url:string}>}
 */
export async function post(baseUrl, endpoint, body, { params = {}, auth = true } = {}) {
  const url = new URL(endpoint, baseUrl);
  for (const [k, v] of Object.entries(commonParams(params))) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
      ...(auth ? authHeader() : {}),
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 2000) };
  }

  const result = { ok: res.ok, status: res.status, body: parsed, url: url.toString() };
  dumpDebug(endpoint.replace(/\W+/g, '-'), result);
  return result;
}

/**
 * Пробует несколько путей-кандидатов и возвращает первый содержательный ответ.
 * Bolt отвечает `code: 0` при успехе; ненулевой code — прикладная ошибка.
 * @returns {Promise<{result:object, attempts:object[]}>}
 */
export async function postFirstWorking(baseUrl, endpoints, body, options = {}) {
  const attempts = [];
  for (const endpoint of endpoints) {
    const result = await post(baseUrl, endpoint, body, options);
    attempts.push({ endpoint, status: result.status, code: result.body?.code });

    // 404/405 — путь не тот, пробуем следующий. Остальное считаем ответом сервиса.
    if (result.status === 404 || result.status === 405) continue;
    return { result, attempts };
  }
  return { result: null, attempts };
}

/** Прикладная ошибка Bolt в читаемом виде. */
export function boltError(result, attempts) {
  if (!result) {
    return new Error(
      'Ни один из известных путей API не ответил (все вернули 404/405). ' +
        `Проверенные пути: ${attempts.map((a) => a.endpoint).join(', ')}. ` +
        'Вероятно, Bolt изменил API — нужен свежий перехват трафика приложения.'
    );
  }
  const code = result.body?.code;
  const message = result.body?.message || result.body?.error_message || '';
  return new Error(
    `Bolt отклонил запрос (HTTP ${result.status}${code !== undefined ? `, code ${code}` : ''})` +
      (message ? `: ${message}` : '.') +
      ` Ответ: ${JSON.stringify(result.body).slice(0, 500)}`
  );
}
