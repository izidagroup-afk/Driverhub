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

/** Ключи имени, которые сами по себе сильно намекают на тариф поездки. */
const STRONG_NAME_KEYS = new Set(['category_name', 'display_name', 'displayName']);

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

/** Имена, которые почти наверняка не тарифы (виджеты/промо/формы). */
const JUNK_NAME_RE =
  /^(email|password|promo|discount|banner|notification|stat|trips?|help|copyright|submit|continue|login)$/i;

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
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'object') {
    // Часто цена приходит объектом { amount, currency } / { text }.
    if (typeof value.text === 'string') return value.text.trim();
    const amount = value.amount ?? value.value ?? value.min ?? value.price;
    const currency = value.currency ?? value.currency_code ?? value.symbol ?? '';
    if (amount !== undefined && amount !== null && amount !== '') {
      return `${amount}${currency ? ' ' + currency : ''}`.trim();
    }
  }
  return null;
}

function looksLikeMoney(priceStr) {
  if (!priceStr) return false;
  // Число или строка с валютой / десятичной ценой.
  if (/^\d+(\.\d+)?$/.test(priceStr)) return true;
  return /(?:€|EUR|\$|£|USD|GBP)\s*\d|\d[\d\s.,]*\s*(?:€|EUR|\$|£|USD|GBP)/i.test(priceStr);
}

function hasStrongCategoryHint(obj, nameKey) {
  if (STRONG_NAME_KEYS.has(nameKey)) return true;
  return (
    Object.prototype.hasOwnProperty.call(obj, 'category_id') ||
    Object.prototype.hasOwnProperty.call(obj, 'categoryId') ||
    Object.prototype.hasOwnProperty.call(obj, 'price_lock_hash') ||
    Object.prototype.hasOwnProperty.call(obj, 'search_token') ||
    Object.prototype.hasOwnProperty.call(obj, 'surge_multiplier') ||
    Object.prototype.hasOwnProperty.call(obj, 'surgeMultiplier')
  );
}

function looksLikeTariff(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

  const name = firstKey(obj, NAME_KEYS);
  const price = firstKey(obj, PRICE_KEYS);
  if (!name || !price) return false;
  if (typeof name.value !== 'string' && typeof name.value !== 'number') return false;

  const nameStr = String(name.value).trim();
  if (!nameStr || nameStr.length > 48 || JUNK_NAME_RE.test(nameStr)) return false;

  const priceStr = stringifyPrice(price.value);
  if (!priceStr || !looksLikeMoney(priceStr)) return false;

  // Нужен явный признак категории поездки.
  // Голый `id` больше не считаем достаточным — слишком много ложных срабатываний
  // (виджеты дашборда, промо и т.п.).
  return hasStrongCategoryHint(obj, name.key);
}

function toTariff(obj) {
  const name = firstKey(obj, NAME_KEYS);
  const price = firstKey(obj, PRICE_KEYS);
  const eta = firstKey(obj, ETA_KEYS);
  const surge = firstKey(obj, SURGE_KEYS);
  let surgeVal = null;
  if (surge) {
    const n = Number(surge.value);
    surgeVal = Number.isFinite(n) ? n : null;
  }
  return {
    name: String(name.value).trim(),
    price: price ? stringifyPrice(price.value) : null,
    eta: eta ? String(eta.value).trim() : null,
    surge: surgeVal,
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
  const list = Array.isArray(payloads) ? payloads : [];
  for (const payload of list) {
    try {
      walk(payload, acc);
    } catch {
      // пропускаем битые полезные нагрузки
    }
  }
  return [...acc.values()];
}
