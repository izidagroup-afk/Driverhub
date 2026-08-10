import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config } from './config.js';

export function hasSession() {
  return fs.existsSync(config.browser.storageStatePath);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Запускает браузер и возвращает { browser, context }.
 * @param {object} opts
 * @param {boolean} [opts.headless]
 * @param {boolean} [opts.useSession] загружать сохранённую сессию, если есть.
 */
export async function launch({ headless = config.browser.headless, useSession = true } = {}) {
  const browser = await chromium.launch({
    headless,
    slowMo: config.browser.slowMo,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const contextOptions = {
    locale: config.browser.locale,
    geolocation: config.browser.geo,
    permissions: ['geolocation'],
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/124.0.0.0 Safari/537.36',
  };

  if (useSession && hasSession()) {
    contextOptions.storageState = config.browser.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  context.setDefaultTimeout(config.browser.timeoutMs);
  context.setDefaultNavigationTimeout(config.browser.timeoutMs);

  return { browser, context };
}

export async function saveSession(context) {
  ensureDir(config.browser.storageStatePath);
  await context.storageState({ path: config.browser.storageStatePath });
}

export function ensureDebugDir() {
  if (!fs.existsSync(config.browser.debugDir)) {
    fs.mkdirSync(config.browser.debugDir, { recursive: true });
  }
  return config.browser.debugDir;
}
