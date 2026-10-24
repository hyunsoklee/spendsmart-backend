// sync/categorize.js
// Decides which budget a transaction belongs to.
// Ladder: merchant rule -> category rule (detailed, then primary) -> Other.
// Hand-tagged rows are protected by the sync runner, not here.

const pool = require('../db');

// "COSTCO " and "Costco" should match the same rule.
function normalizeMerchantName(name) {
  return name ? name.trim().toLowerCase() : null;
}

// Load all rules once per sync run. The tables are small.
async function loadRules() {
  const [catRes, merchRes, otherRes] = await Promise.all([
    pool.query('SELECT plaid_category, budget_id, skip FROM category_rules'),
    pool.query('SELECT merchant_entity_id, merchant_name, budget_id FROM merchant_rules'),
    pool.query("SELECT id FROM budgets WHERE is_system = true AND category = 'other'"),
  ]);

  if (otherRes.rows.length === 0) {
    throw new Error('No "other" budget row found. Was migration 002 run?');
  }

  const byCategory = new Map();
  for (const r of catRes.rows) {
    byCategory.set(r.plaid_category, { budgetId: r.budget_id, skip: r.skip });
  }

  const byMerchantId = new Map();
  const byMerchantName = new Map();
  for (const r of merchRes.rows) {
    if (r.merchant_entity_id) byMerchantId.set(r.merchant_entity_id, r.budget_id);
    if (r.merchant_name) byMerchantName.set(normalizeMerchantName(r.merchant_name), r.budget_id);
  }

  return { byCategory, byMerchantId, byMerchantName, otherId: otherRes.rows[0].id };
}

// Returns { categoryId, excluded }.
// excluded = true means "not spending" (card payment, transfer): keep it in
// the feed, leave it out of budget math.
function categorize(txn, rules) {
  // Rung 2: merchant rule, by stable id first, then by name
  if (txn.merchantEntityId && rules.byMerchantId.has(txn.merchantEntityId)) {
    return { categoryId: rules.byMerchantId.get(txn.merchantEntityId), excluded: false };
  }
  const nameKey = normalizeMerchantName(txn.merchantName);
  if (nameKey && rules.byMerchantName.has(nameKey)) {
    return { categoryId: rules.byMerchantName.get(nameKey), excluded: false };
  }

  // Rung 3: category rule, detailed first, then primary
  const rule =
    (txn.categoryDetailed && rules.byCategory.get(txn.categoryDetailed)) ||
    (txn.categoryPrimary && rules.byCategory.get(txn.categoryPrimary));
  if (rule) {
    if (rule.skip) return { categoryId: null, excluded: true };
    return { categoryId: rule.budgetId, excluded: false };
  }

  // Rung 4: Other
  return { categoryId: rules.otherId, excluded: false };
}

module.exports = { loadRules, categorize, normalizeMerchantName };