// kinds.js
// The kinds of charge a category can be built from.
// A "kind" is the bank's specific label for a charge (Plaid's detailed
// category), for example gas and electricity, or childcare.
//
// Only charges a kind rule could actually move are counted:
//   - filed automatically (never the ones placed by hand)
//   - not already decided by a remembered merchant, which outranks the kind
//   - real spending (card payments and transfers are never offered)

const pool = require('./db');
const { loadRules, categorize, normalizeMerchantName } = require('./sync/categorize');
const { DEFAULT_TIME_ZONE } = require('./spending');
const { suggestedKindsFor } = require('./suggestions');

// Readable names the automatic wording gets wrong.
const LABEL_OVERRIDES = {
  BANK_FEES_INTEREST_CHARGE: 'Interest charges',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'Events, parks and museums',
  ENTERTAINMENT_TV_AND_MOVIES: 'TV and movies',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'Beer, wine and liquor',
  FOOD_AND_DRINK_COFFEE: 'Coffee shops',
  FOOD_AND_DRINK_RESTAURANT: 'Restaurants',
  TRANSPORTATION_GAS: 'Gas stations',
};

// The bank's broad groups. A kind's code starts with its group's code.
const GROUPS = [
  'GOVERNMENT_AND_NON_PROFIT', 'RENT_AND_UTILITIES', 'GENERAL_MERCHANDISE',
  'HOME_IMPROVEMENT', 'LOAN_DISBURSEMENTS', 'GENERAL_SERVICES', 'FOOD_AND_DRINK',
  'LOAN_PAYMENTS', 'PERSONAL_CARE', 'TRANSPORTATION', 'ENTERTAINMENT',
  'TRANSFER_OUT', 'TRANSFER_IN', 'BANK_FEES', 'MEDICAL', 'INCOME', 'TRAVEL', 'OTHER',
];

// 'MEDICAL_PRIMARY_CARE' -> 'MEDICAL'
function groupOfKind(kind) {
  return GROUPS.find((g) => kind === g || kind.startsWith(g + '_')) || null;
}

// 'RENT_AND_UTILITIES' -> 'Rent and utilities'
function words(code) {
  const text = String(code || '').toLowerCase().replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// The part of a kind after its broad group:
// ('MEDICAL_PRIMARY_CARE', 'MEDICAL') -> 'PRIMARY_CARE'
function withoutGroup(kind, group) {
  return group && kind.startsWith(group + '_') ? kind.slice(group.length + 1) : kind;
}

function labelForKind(kind, group) {
  return LABEL_OVERRIDES[kind] || words(withoutGroup(kind, group));
}

// The bank's own catch-alls ("other general services") say too little to
// build a rule on. Those are better handled merchant by merchant.
function isVague(kind, group) {
  return withoutGroup(kind, group).startsWith('OTHER');
}

function hasMerchantRule(row, rules) {
  if (row.merchant_entity_id && rules.byMerchantId.has(row.merchant_entity_id)) return true;
  const nameKey = normalizeMerchantName(row.merchant_name);
  return Boolean(nameKey && rules.byMerchantName.has(nameKey));
}

// Every kind seen this month or last month, with where it files today.
// options:
//   name             a category name; kinds that usually go with it are
//                    marked as suggested, and listed even with no charges
//   include          kind codes to list even with no charges lately
//   suggestIncluded  also mark the included codes as suggested
async function listKinds(timeZone = DEFAULT_TIME_ZONE, options = {}) {
  const { name = '', include = [], suggestIncluded = false } = options;

  const rules = await loadRules();
  // What the kind alone would decide, ignoring remembered merchants.
  const kindRulesOnly = { ...rules, byMerchantId: new Map(), byMerchantName: new Map() };

  const [txnRes, budgetRes] = await Promise.all([
    pool.query(
      `WITH bounds AS (
         SELECT (date_trunc('month', now() AT TIME ZONE $1::text) - interval '1 month')::date AS last_start,
                date_trunc('month', now() AT TIME ZONE $1::text)::date AS this_start,
                (date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month')::date AS this_end
       )
       SELECT t.merchant_entity_id, t.merchant_name, t.provider_category,
              t.provider_category_primary, t.amount_cents,
              (t.date >= b.this_start) AS this_month
       FROM transactions t
       CROSS JOIN bounds b
       WHERE t.category_source = 'auto'
         AND t.removed_at IS NULL
         AND t.provider_category IS NOT NULL
         AND t.date >= b.last_start
         AND t.date <  b.this_end`,
      [timeZone]
    ),
    pool.query('SELECT id, category, icon, is_system FROM budgets'),
  ]);

  const budgets = new Map(budgetRes.rows.map((b) => [b.id, b]));
  const byKind = new Map();

  // Where a kind files today, or null if it is not one to offer.
  const placeFor = (kind, group) => {
    if (!kind || isVague(kind, group)) return null;
    const now = categorize({ categoryDetailed: kind, categoryPrimary: group }, kindRulesOnly);
    if (now.excluded) return null;
    return budgets.get(now.categoryId) || null;
  };

  for (const row of txnRes.rows) {
    if (hasMerchantRule(row, rules)) continue;

    const kind = row.provider_category;
    const group = row.provider_category_primary;

    let entry = byKind.get(kind);
    if (!entry) {
      const filedIn = placeFor(kind, group);
      if (!filedIn) continue;
      entry = { kind, group, filedIn, charges: 0, cents: 0, lastMonthCents: 0 };
      byKind.set(kind, entry);
    }
    if (row.this_month) {
      entry.charges += 1;
      entry.cents += row.amount_cents;
    } else {
      entry.lastMonthCents += row.amount_cents;
    }
  }

  // Kinds asked for by name or by code, even with no charges lately.
  const suggested = suggestedKindsFor(name);
  if (suggestIncluded) include.forEach((code) => suggested.add(code));
  for (const kind of new Set([...suggested, ...include])) {
    if (typeof kind !== 'string' || byKind.has(kind)) continue;
    const group = groupOfKind(kind);
    if (!group || kind === group) continue;
    const filedIn = placeFor(kind, group);
    if (!filedIn) continue;
    byKind.set(kind, { kind, group, filedIn, charges: 0, cents: 0, lastMonthCents: 0 });
  }

  const kinds = [...byKind.values()]
    .map((k) => ({
      kind: k.kind,
      label: labelForKind(k.kind, k.group),
      group: words(k.group),
      charges: k.charges,
      amount: Math.round(k.cents / 100),
      amountCents: k.cents,
      lastMonthAmount: Math.round(k.lastMonthCents / 100),
      lastMonthCents: k.lastMonthCents,
      filedIn: {
        id: k.filedIn.id,
        category: k.filedIn.category,
        icon: k.filedIn.icon,
        isOther: k.filedIn.is_system,
      },
      suggested: suggested.has(k.kind),
    }))
    .sort((a, b) => b.amount - a.amount || b.lastMonthAmount - a.lastMonthAmount);

  return { kinds };
}

module.exports = { listKinds, labelForKind, isVague, groupOfKind };