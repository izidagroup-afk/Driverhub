import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, assertCredentials } from './config.js';
import * as webProvider from './boltBusiness.js';
import * as mobileProvider from './mobile/index.js';

const isMobile = config.provider === 'mobile';
const provider = isMobile ? mobileProvider : webProvider;
const { getPrices, hasSession } = provider;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

/**
 * Простой sliding-window rate limiter по IP (без внешних зависимостей).
 */
export function createRateLimiter({ windowMs, max } = {}) {
  const hits = new Map();

  return function rateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    let stamps = hits.get(ip) || [];
    stamps = stamps.filter((t) => now - t < windowMs);
    if (stamps.length >= max) {
      return res.status(429).json({
        error: `Слишком много запросов с вашего IP. Подождите и повторите (лимит ${max}/${Math.round(windowMs / 1000)}с).`,
      });
    }
    stamps.push(now);
    hits.set(ip, stamps);
    next();
  };
}

function extractProvidedToken(req) {
  const header = req.get('authorization') || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const alt = req.get('x-api-token');
  return alt ? String(alt).trim() : '';
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.apiToken]
 * @param {number} [overrides.rateLimitWindowMs]
 * @param {number} [overrides.rateLimitMax]
 */
export function createApp(overrides = {}) {
  const apiToken = overrides.apiToken ?? config.apiToken;
  const windowMs = overrides.rateLimitWindowMs ?? config.rateLimit.windowMs;
  const max = overrides.rateLimitMax ?? config.rateLimit.max;

  const app = express();
  app.set('trust proxy', false);

  app.use(
    express.json({
      // null/примитивы не считаем валидным телом запроса (проверяем ниже).
      strict: false,
    })
  );

  // Конфиг для UI (токен отдаём same-origin скриптом — локальный инструмент).
  app.get('/app-config.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(
      `window.__BPP_CONFIG__=${JSON.stringify({
        apiToken: apiToken || null,
        authRequired: Boolean(apiToken),
      })};`
    );
  });

  app.use(express.static(publicDir));

  // Простая защита от параллельных запусков браузера (портал не любит гонки).
  let busy = false;
  const rateLimit = createRateLimiter({ windowMs, max });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      hasSession: hasSession(),
      city: config.bolt.defaultCity,
      provider: config.provider,
      credentialsConfigured: isMobile
        ? Boolean(config.mobile.phone || config.mobile.accessToken || hasSession())
        : Boolean(config.bolt.email && config.bolt.password),
      authRequired: Boolean(apiToken),
    });
  });

  app.post('/api/prices', rateLimit, (req, res, next) => {
    if (apiToken) {
      const provided = extractProvidedToken(req);
      if (!provided || provided !== apiToken) {
        return res.status(401).json({
          error: 'Неверный или отсутствующий API-токен. Передайте Authorization: Bearer <API_TOKEN>.',
        });
      }
    }
    next();
  }, async (req, res) => {
    const body = req.body;
    if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Укажите pickup и destination.' });
    }
    const { pickup, destination } = body;
    if (
      typeof pickup !== 'string' ||
      typeof destination !== 'string' ||
      !pickup.trim() ||
      !destination.trim()
    ) {
      return res.status(400).json({ error: 'Укажите pickup и destination.' });
    }
    // Мобильному источнику email/пароль не нужны — там телефон и токен.
    if (!isMobile) {
      try {
        assertCredentials();
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    if (busy) {
      return res
        .status(429)
        .json({ error: 'Уже выполняется другой запрос. Подождите завершения и повторите.' });
    }

    busy = true;
    const startedAt = Date.now();
    try {
      const result = await getPrices({
        pickup: pickup.trim(),
        destination: destination.trim(),
      });
      result.elapsedMs = Date.now() - startedAt;
      res.json(result);
    } catch (err) {
      console.error('[prices] ошибка:', err);
      res.status(502).json({ error: err.message || String(err) });
    } finally {
      busy = false;
    }
  });

  // body-parser SyntaxError (битый JSON) → понятный 400 вместо HTML.
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      return res.status(400).json({ error: 'Укажите pickup и destination.' });
    }
    next(err);
  });

  return app;
}

function isMainModule() {
  const entry = process.argv[1] && path.resolve(process.argv[1]);
  return entry && fileURLToPath(import.meta.url) === entry;
}

if (isMainModule()) {
  const app = createApp();
  const host = config.host;
  app.listen(config.port, host, () => {
    const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`\nBolt price parser запущен: http://${displayHost}:${config.port}`);
    console.log(`[i] Слушает ${host}:${config.port}`);
    if (config.apiToken) {
      console.log('[i] API_TOKEN задан — POST /api/prices требует Authorization: Bearer …');
    } else {
      console.log('[i] API_TOKEN не задан — /api/prices без токена (нормально для localhost).');
    }
    console.log(
      `[i] Источник цен: ${isMobile ? 'мобильное приложение (PROVIDER=mobile)' : 'веб-портал Bolt Business (PROVIDER=web)'}`
    );
    if (!isMobile && (!config.bolt.email || !config.bolt.password)) {
      console.warn('[!] BOLT_EMAIL / BOLT_PASSWORD не заданы — заполните .env.');
    }
    if (!hasSession()) {
      console.warn(
        `[!] Сессия не найдена. Выполните один раз: ${isMobile ? 'npm run login:mobile' : 'npm run login'}`
      );
    }
  });
}
