/**
 * Источник цен «мобильное приложение»: адрес → координаты → поиск тарифов.
 * Интерфейс совпадает с веб-источником, поэтому сервер и UI не меняются.
 */
import { config } from '../config.js';
import { geocodeAddress } from './geocode.js';
import { findRideOptions, parseRideOptions, parseMeta } from './prices.js';
import { hasMobileSession } from './session.js';

function guessCurrency(tariffs) {
  for (const t of tariffs) {
    if (!t.price) continue;
    const m = t.price.match(/€|EUR|\$|£|USD|GBP|zł|PLN/i);
    if (m) return m[0];
  }
  return null;
}

export async function getPrices({ pickup, destination }) {
  if (!pickup || !destination) {
    throw new Error('Нужно указать адреса начала (pickup) и конца (destination).');
  }
  if (!hasMobileSession() && !config.mobile.accessToken) {
    throw new Error(
      'Нет сессии мобильного приложения. Выполните вход: `npm run login:mobile` ' +
        '(номер телефона + код из СМС) или задайте готовый BOLT_ACCESS_TOKEN в .env.'
    );
  }

  const [from, to] = await Promise.all([geocodeAddress(pickup), geocodeAddress(destination)]);
  const payload = await findRideOptions(from, to);
  const tariffs = parseRideOptions(payload);
  const meta = parseMeta(payload);

  return {
    pickup,
    destination,
    city: meta.city || config.bolt.defaultCity,
    currency: guessCurrency(tariffs),
    fetchedAt: new Date().toISOString(),
    tariffs,
    source: 'bolt-mobile-api',
    coordinates: {
      pickup: { lat: from.lat, lng: from.lng },
      destination: { lat: to.lat, lng: to.lng },
    },
  };
}

export { hasMobileSession as hasSession };
