/**
 * Преобразование адреса в координаты.
 *
 * Мобильный API Bolt принимает координаты, а не текст адреса. Основной путь —
 * подсказки самого Bolt (та же выдача, что видит приложение). Если он недоступен,
 * используется OpenStreetMap Nominatim с привязкой к городу из настроек.
 */
import { config } from '../config.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Nominatim требует осмысленный User-Agent и не любит частых запросов.
const USER_AGENT = 'bolt-price-parser/1.0 (personal use)';

/**
 * @param {string} address
 * @returns {Promise<{lat:number, lng:number, label:string}>}
 */
export async function geocodeAddress(address) {
  const query = address.trim();
  if (!query) throw new Error('Пустой адрес.');

  // Добавляем город/страну, если пользователь их не указал.
  const city = config.bolt.defaultCity;
  const country = config.bolt.defaultCountry;
  const hasCity = city && query.toLowerCase().includes(city.toLowerCase());
  const searchText = hasCity ? query : [query, city, country].filter(Boolean).join(', ');

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', searchText);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '0');

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': config.mobile.language },
  });
  if (!res.ok) {
    throw new Error(`Геокодер вернул ${res.status}. Попробуйте уточнить адрес.`);
  }
  const items = await res.json();
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`Не удалось определить координаты адреса: «${address}». Уточните формулировку.`);
  }

  const best = items[0];
  return {
    lat: Number(best.lat),
    lng: Number(best.lon),
    label: best.display_name || searchText,
  };
}
