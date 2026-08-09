import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, assertCredentials } from './config.js';
import { getPrices, hasSession } from './boltBusiness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// Простая защита от параллельных запусков браузера (портал не любит гонки).
let busy = false;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasSession: hasSession(),
    city: config.bolt.defaultCity,
    credentialsConfigured: Boolean(config.bolt.email && config.bolt.password),
  });
});

app.post('/api/prices', async (req, res) => {
  const { pickup, destination } = req.body || {};
  if (!pickup || !destination) {
    return res.status(400).json({ error: 'Укажите pickup и destination.' });
  }
  try {
    assertCredentials();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  if (busy) {
    return res
      .status(429)
      .json({ error: 'Уже выполняется другой запрос. Подождите завершения и повторите.' });
  }

  busy = true;
  const startedAt = Date.now();
  try {
    const result = await getPrices({ pickup, destination });
    result.elapsedMs = Date.now() - startedAt;
    res.json(result);
  } catch (err) {
    console.error('[prices] ошибка:', err);
    res.status(502).json({ error: err.message });
  } finally {
    busy = false;
  }
});

app.listen(config.port, () => {
  console.log(`\nBolt price parser запущен: http://localhost:${config.port}`);
  if (!config.bolt.email || !config.bolt.password) {
    console.warn('[!] BOLT_EMAIL / BOLT_PASSWORD не заданы — заполните .env.');
  }
  if (!hasSession()) {
    console.warn('[!] Сессия не найдена. Выполните один раз: HEADLESS=false npm run login');
  }
});
