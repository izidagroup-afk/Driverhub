/**
 * Мок приватного API мобильного приложения Bolt: вход по СМС и поиск тарифов.
 * Формы запросов/ответов повторяют задокументированный перехватом контракт.
 */
import express from 'express';
import { createServer } from 'node:http';

const VALID_CODE = '1234';

export function createMockMobileApi(initialConfig = {}) {
  const app = express();
  app.use(express.json());

  let mockConfig = {
    // Известный путь входа: 'v2' (как у приложения) или 'plain' (без суффикса).
    startPathStyle: 'v2',
    confirmPathStyle: 'v3',
    // Режим поиска: ok | unauthorized | error
    searchMode: 'ok',
    validCode: VALID_CODE,
    ...initialConfig,
  };

  app.setMockConfig = (patch) => {
    mockConfig = { ...mockConfig, ...patch };
  };

  const issued = new Set();

  function notFound(res) {
    return res.status(404).json({ code: 404, message: 'Not found' });
  }

  function startHandler(style) {
    return (req, res) => {
      if (mockConfig.startPathStyle !== style) return notFound(res);
      const { phone_number: phone, phone_uuid: uuid, type, method } = req.body || {};
      if (type !== 'phone' || method !== 'sms' || !uuid) {
        return res.json({ code: 1001, message: 'BAD_REQUEST' });
      }
      if (!/^\+\d{7,15}$/.test(String(phone || ''))) {
        return res.json({ code: 1002, message: 'INVALID_PHONE' });
      }
      res.json({ code: 0, message: 'OK', data: { verification_token: 'vt_mock' } });
    };
  }

  function confirmHandler(style) {
    return (req, res) => {
      if (mockConfig.confirmPathStyle !== style) return notFound(res);
      const { code, phone_number: phone, phone_uuid: uuid } = req.body || {};
      if (!phone || !uuid) return res.json({ code: 1001, message: 'BAD_REQUEST' });
      if (String(code) !== String(mockConfig.validCode)) {
        return res.json({ code: 2001, message: 'INVALID_VERIFICATION_CODE' });
      }
      const accessToken = 'access_mock_token';
      issued.add(accessToken);
      res.json({
        code: 0,
        message: 'OK',
        data: {
          user_id: 777001,
          auth: {
            auth_token: 'auth_mock_token',
            access_token: accessToken,
            refresh_token: 'refresh_mock_token',
            first_name: 'Test',
          },
        },
      });
    };
  }

  app.post('/profile/verification/start/v2', startHandler('v2'));
  app.post('/profile/verification/start', startHandler('plain'));
  app.post('/profile/verification/confirm/v3', confirmHandler('v3'));
  app.post('/profile/verification/confirm/v2', confirmHandler('v2'));
  app.post('/profile/verification/confirm', confirmHandler('plain'));

  app.post('/findRideOptions', (req, res) => {
    const auth = req.get('authorization') || '';
    const token = (auth.match(/^Bearer\s+(.+)$/i) || [])[1];
    if (mockConfig.searchMode === 'unauthorized' || !token || !issued.has(token)) {
      return res.status(401).json({ code: 503, message: 'USER_NOT_AUTHORIZED' });
    }
    if (mockConfig.searchMode === 'error') {
      return res.json({ code: 7002, message: 'PRICE_LOCK_NOT_FOUND' });
    }

    const { pickup_stop: pickup, destination_stops: stops } = req.body || {};
    if (!pickup?.lat || !pickup?.lng || !Array.isArray(stops) || !stops[0]?.lat) {
      return res.json({ code: 1001, message: 'BAD_REQUEST' });
    }

    res.json({
      code: 0,
      message: 'OK',
      data: {
        search_token: '1617555086000559',
        country: 'lv',
        city: 'Rīga',
        search_categories: [
          {
            id: 48,
            name: 'Bolt',
            seats: 4,
            eta_info: { pickup_eta: 180 },
            price: { lock_hash: 'hash1', surge_multiplier: 1, actual: '8.50 €' },
          },
          {
            id: 52,
            name: 'Comfort',
            seats: 4,
            eta_info: { pickup_eta: 240 },
            price: { lock_hash: 'hash2', surge_multiplier: 1.3, actual: '11.20 €' },
          },
          {
            id: 60,
            name: 'XL',
            seats: 6,
            eta_info: { pickup_eta: 420 },
            price: { lock_hash: 'hash3', surge_multiplier: 1, actual: '14.90 €' },
          },
        ],
      },
    });
  });

  return app;
}

export async function startMockMobileApi(port = 0, initialConfig = {}) {
  const app = createMockMobileApi(initialConfig);
  const server = createServer(app);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    setConfig: (patch) => app.setMockConfig(patch),
    async close() {
      await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    },
  };
}
