/**
 * Вход как в мобильном приложении: номер телефона → код из СМС → токен.
 *
 * Пути `/profile/verification/start/v2` и `/confirm/v3` подтверждены как
 * существующие на рабочем хосте приложения, но их тела запросов публично не
 * описаны. Используется форма, подтверждённая на соседнем клиенте Bolt того же
 * семейства; дополнительно перебираются версии путей без суффикса.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { post, postFirstWorking, boltError } from './client.js';
import { loadMobileSession, saveMobileSession } from './session.js';

const START_ENDPOINTS = [
  '/profile/verification/start/v2',
  '/profile/verification/start',
];

const CONFIRM_ENDPOINTS = [
  '/profile/verification/confirm/v3',
  '/profile/verification/confirm/v2',
  '/profile/verification/confirm',
];

function normalizePhone(phone) {
  const trimmed = String(phone || '').replace(/[\s()-]/g, '');
  if (!/^\+\d{7,15}$/.test(trimmed)) {
    throw new Error(
      `Телефон должен быть в международном формате, например +37120000000. Получено: «${phone}».`
    );
  }
  return trimmed;
}

/** Постоянный идентификатор номера: Bolt связывает им шаги start и confirm. */
function getOrCreatePhoneUuid() {
  const session = loadMobileSession();
  if (session?.phoneUuid) return session.phoneUuid;
  const phoneUuid = crypto.randomUUID();
  saveMobileSession({ phoneUuid });
  return phoneUuid;
}

/**
 * Шаг 1: запросить СМС с кодом.
 * @param {string} phone
 */
export async function startVerification(phone) {
  const phoneNumber = normalizePhone(phone);
  const phoneUuid = getOrCreatePhoneUuid();

  const body = {
    type: 'phone',
    phone_uuid: phoneUuid,
    phone_number: phoneNumber,
    method: 'sms',
    last_known_state: {},
  };

  const { result, attempts } = await postFirstWorking(
    config.mobile.baseUrl,
    START_ENDPOINTS,
    body,
    { auth: false }
  );

  if (!result || result.body?.code !== 0) {
    throw boltError(result, attempts.map((a, i) => ({ ...a, endpoint: START_ENDPOINTS[i] })));
  }

  saveMobileSession({ phone: phoneNumber, phoneUuid });
  return { phone: phoneNumber, verificationToken: extractVerificationToken(result.body) };
}

function extractVerificationToken(body) {
  const data = body?.data || {};
  return (
    data.verification_token ||
    data.verification_code_channel ||
    data.token ||
    null
  );
}

/**
 * Шаг 2: подтвердить код из СМС и сохранить токен.
 * @param {string} code
 */
export async function confirmVerification(code) {
  const session = loadMobileSession() || {};
  if (!session.phone || !session.phoneUuid) {
    throw new Error('Сначала запросите код: сессия с номером телефона не найдена.');
  }
  const trimmed = String(code || '').trim();
  if (!/^\d{3,8}$/.test(trimmed)) {
    throw new Error(`Код из СМС должен состоять из цифр. Получено: «${code}».`);
  }

  const body = {
    type: 'phone',
    phone_number: session.phone,
    phone_uuid: session.phoneUuid,
    code: trimmed,
    last_known_state: {},
  };

  const { result, attempts } = await postFirstWorking(
    config.mobile.baseUrl,
    CONFIRM_ENDPOINTS,
    body,
    { auth: false }
  );

  if (!result || result.body?.code !== 0) {
    throw boltError(result, attempts.map((a, i) => ({ ...a, endpoint: CONFIRM_ENDPOINTS[i] })));
  }

  const tokens = extractTokens(result.body);
  if (!tokens.accessToken && !tokens.refreshToken && !tokens.authToken) {
    throw new Error(
      'Код принят, но в ответе не нашёлся токен. Ответ: ' +
        JSON.stringify(result.body).slice(0, 800)
    );
  }

  saveMobileSession(tokens);
  return tokens;
}

function extractTokens(body) {
  const data = body?.data || {};
  const auth = data.auth || data.tokens || data.token || data;
  return {
    accessToken: auth.access_token || auth.accessToken || null,
    refreshToken: auth.refresh_token || auth.refreshToken || null,
    authToken: auth.auth_token || auth.authToken || null,
    userId: data.user_id || data.id || auth.user_id || null,
    firstName: auth.first_name || data.first_name || null,
  };
}

/** Диагностика: одиночный запрос к произвольному пути (для отладки контракта). */
export async function probe(endpoint, body = {}) {
  return post(config.mobile.baseUrl, endpoint, body, { auth: true });
}
