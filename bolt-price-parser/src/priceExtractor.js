/**
 * Универсальный извлекатель тарифов из JSON-ответов внутреннего бэкенда Bolt.
 *
 * Bolt не публикует схему, поэтому мы эвристически ищем в графе объектов
 * массивы «категорий поездки», у которых есть имя тарифа и цена.
 * Это устойчивее, чем скрейпинг DOM, и легко адаптируется при смене схемы.
 */

const NAME_KEYS = [
  'category_name',
  'display_name',
  'displayName',
  'name',
  'title',
  'label',
  'category',
];

const PRICE_KEYS = [
  'price_str',
  'priceStr',
  'price_string',
  'price',
  'price_estimate',
  'priceEstimate',
  'estimated_price',
  'estimatedPrice',
  'fare',
  'fare_str',
  'min_price',
  'amount',
  'price_text',
];

const ETA_KEYS = [
  'eta_str',
  'pickup_eta',
  'pickupEta',
  'pickup_eta_string',
  'eta',
  'eta_seconds',
  'pickup_eta_seconds',
];

const SURGE_KEYS = ['surge_multiplier', 'surgeMultiplier', 'surge'];

function firstKey(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v !== null && v !== undefined && v !== '') return { key: k, value: v };
    }
  }
  return null;
}

function stringifyPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    // Часто цена приходит объектом { amount, currency } / { text }.
    if (typeof value.text === 'string') return value.text.trim();
    const amount = value.amount ?? value.value ?? value.min ?? value.price;
    const currency = value.currency ?? value.currency_code ?? value.symbol ?? '';
    if (amount !== undefined && amount !== null) {
      return `${amount}${currency ? ' ' + currency : ''}`.trim();
    }
  }
  return null;
}

function looksLikeTariff(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const name = firstKey(obj, NAME_KEYS);
  const price = firstKey(obj, PRICE_KEYS);
  if (!name) return false;
  if (typeof name.value !== 'string' && typeof name.value !== 'number') return false;
  const priceStr = price ? stringifyPrice(price.value) : null;
  // Считаем тарифом, если есть имя И (цена ИЛи явный признак категории поездки).
  const hasCategoryHint =
    'category_id' in obj ||
    'categoryId' in obj ||
    'id' in obj ||
    'price_lock_hash' in obj ||
    'search_token' in obj;
  return Boolean(priceStr) && hasCategoryHint;
}

function toTariff(obj) {
  const name = firstKey(obj, NAME_KEYS);
  const price = firstKey(obj, PRICE_KEYS);
  const eta = firstKey(obj, ETA_KEYS);
  const surge = firstKey(obj, SURGE_KEYS);
  return {
    name: String(name.value).trim(),
    price: price ? stringifyPrice(price.value) : null,
    eta: eta ? String(eta.value).trim() : null,
    surge: surge ? Number(surge.value) : null,
  };
}

/**
 * Рекурсивно обходит произвольный JSON и собирает найденные тарифы.
 * @param {*} node
 * @param {Map<string, object>} acc
 */
function walk(node, acc, depth = 0) {
  if (depth > 12 || node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) walk(item, acc, depth + 1);
    return;
  }

  if (looksLikeTariff(node)) {
    const t = toTariff(node);
    const key = `${t.name}|${t.price}`;
    if (!acc.has(key)) acc.set(key, t);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') walk(value, acc, depth + 1);
  }
}

/**
 * @param {object[]} payloads список распарсенных JSON-ответов
 * @returns {{name:string, price:string|null, eta:string|null, surge:number|null}[]}
 */
export function extractTariffs(payloads) {
  const acc = new Map();
  for (const payload of payloads) {
    try {
      walk(payload, acc);
    } catch {
      // пропускаем битые полезные нагрузки
    }
  }
  return [...acc.values()];
}
