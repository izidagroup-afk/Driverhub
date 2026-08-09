/**
 * Хранение сессии «мобильного устройства»: идентификатор устройства и токен,
 * полученный после подтверждения кода из СМС.
 *
 * deviceId должен быть постоянным: Bolt привязывает сессию к устройству, и
 * смена идентификатора при каждом запуске выглядит как вход с нового телефона.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function loadMobileSession() {
  const file = config.mobile.sessionPath;
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function saveMobileSession(patch) {
  const file = config.mobile.sessionPath;
  ensureDir(file);
  const current = loadMobileSession() || {};
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function hasMobileSession() {
  const s = loadMobileSession();
  return Boolean(s && (s.refreshToken || s.accessToken));
}

/** Постоянный идентификатор устройства: берётся из сессии или создаётся один раз. */
export function getOrCreateDeviceId() {
  const existing = loadMobileSession();
  if (existing?.deviceId) return existing.deviceId;
  const deviceId = crypto.randomUUID();
  saveMobileSession({ deviceId });
  return deviceId;
}
