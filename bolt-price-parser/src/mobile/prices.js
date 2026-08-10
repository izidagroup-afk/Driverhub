/**
 * Поиск тарифов, как это делает приложение.
 *
 * Контракт `findRideOptions` подтверждён перехватом трафика: в ответе приходит
 * `data.search_categories[]`, где у каждой категории есть имя, отформатированная
 * цена, время подачи и `surge_multiplier` — множитель спроса, который в самом
 * приложении не показывается.
 */
import { config } from '../config.js';
import { postFirstWorking, boltError } from './client.js';

const SEARCH_ENDPOINTS = ['/findRideOptions', '/search/findRideOptions'];

/**
 * @param {{lat:number,lng:number}} pickup
 * @param {{lat:number,lng:number}} destination
 */
export async function findRideOptions(pickup, destination) {
  const body = {
    pickup_stop: { lat: pickup.lat, lng: pickup.lng },
    destination_stops: [{ lat: destination.lat, lng: destination.lng }],
    payment_method_id: 'cash',
    payment_method_type: 'default',
    preliminary: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Riga',
  };

  const { result, attempts } = await postFirstWorking(
    config.mobile.searchBaseUrl,
    SEARCH_ENDPOINTS,
    body,
    { params: { gps_lat: String(pickup.lat), gps_lng: String(pickup.lng) } }
  );

  if (!result || result.body?.code !== 0) {
    throw boltError(
      result,
      attempts.map((a, i) => ({ ...a, endpoint: SEARCH_ENDPOINTS[i] }))
    );
  }
  return result.body;
}

function formatEta(category) {
  const seconds = category?.eta_info?.pickup_eta ?? category?.eta_info?.eta ?? null;
  if (seconds === null || seconds === undefined) return null;
  const num = Number(seconds);
  if (!Number.isFinite(num)) return String(seconds);
  // В ответе приходят секунды; в приложении показываются минуты.
  return `${Math.max(1, Math.round(num / 60))} мин`;
}

/**
 * Приводит ответ поиска к общему виду тарифов приложения.
 * @returns {{name:string, price:string|null, eta:string|null, surge:number|null}[]}
 */
export function parseRideOptions(payload) {
  const categories = payload?.data?.search_categories;
  if (!Array.isArray(categories)) return [];

  const seen = new Set();
  const tariffs = [];
  for (const category of categories) {
    const name = category?.name || category?.display_name || null;
    if (!name) continue;

    const price = category?.price || {};
    const priceText =
      price.actual ||
      price.price_str ||
      price.text ||
      (price.amount !== undefined ? String(price.amount) : null);

    const key = `${name}|${priceText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const surge = price.surge_multiplier ?? price.surgeMultiplier ?? null;
    tariffs.push({
      name: String(name),
      price: priceText ? String(priceText) : null,
      eta: formatEta(category),
      surge: surge === null || surge === undefined ? null : Number(surge),
    });
  }
  return tariffs;
}

/** Валюта/город из ответа — для отображения. */
export function parseMeta(payload) {
  const data = payload?.data || {};
  return {
    city: data.city || null,
    country: data.country || null,
    searchToken: data.search_token || null,
  };
}
