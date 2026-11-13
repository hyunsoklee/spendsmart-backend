// retag.js
// Moves a charge to another budget category and remembers the merchant.
//
// remember = true (default): save a merchant rule, and re-file this merchant's
//   other auto-tagged charges from this month.
// remember = false ("Just this once"): keep the tag on this one charge, put the
//   merchant's rule back to what it was (restoreRuleBudgetId, or no rule), and
//   put the other auto-tagged charges back where the rules say.
//
// Hand-tagged charges and closed months are never changed.

const pool = require('./db');
const { loadRules, categorize, normalizeMerchantName } = require('./sync/categorize');
const { DEFAULT_TIME_ZONE } = require('./spending');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function retagTransaction(txnId, budgetId, options = {}) {
  const {
    remember = true,
    restoreRuleBudgetId = null,
    timeZone = DEFAULT_TIME_ZONE,
  } = options;

  // Current saved rules. The merchant's entry is adjusted in memory below so
  // the re-filing step sees the rule as it will be after this change.
  const rules = await loadRules();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const txnRes = await client.query(
      `SELECT id, merchant_entity_id, merchant_name
       FROM transactions
       WHERE id = $1 AND removed_at IS NULL
       FOR UPDATE`,
      [txnId]
    );
    const txn = txnRes.rows[0];
    if (!txn) throw httpError(404, 'Transaction not found');

    const budgetRes = await client.query('SELECT id, category FROM budgets WHERE id = $1', [budgetId]);
    const budget = budgetRes.rows[0];
    if (!budget) throw httpError(400, 'Unknown budget category');

    // 1. Tag this charge by hand. Syncs will never change it again.
    await client.query(
      `UPDATE transactions
       SET category_id = $1, category_source = 'user', excluded = false, updated_at = now()
       WHERE id = $2`,
      [budgetId, txnId]
    );

    const result = {
      transactionId: txnId,
      budgetId,
      category: budget.category,
      merchant: txn.merchant_name,
      ruleSaved: false,
      previousRuleBudgetId: null,
      refiled: 0,
    };

    // 2. Which merchant is this? Plaid's stable id if there is one, else the name.
    const entityId = txn.merchant_entity_id;
    const nameKey = normalizeMerchantName(txn.merchant_name);
    if (!entityId && !nameKey) {
      // Nothing reliable to build a rule on: only this one charge is tagged.
      await client.query('COMMIT');
      return result;
    }

    // ruleColumn is one of two fixed names, never user input.
    const ruleColumn = entityId ? 'merchant_entity_id' : 'merchant_name';
    const ruleKey = entityId || nameKey;
    const ruleMap = entityId ? rules.byMerchantId : rules.byMerchantName;

    const prevRes = await client.query(
      `SELECT budget_id FROM merchant_rules WHERE ${ruleColumn} = $1`,
      [ruleKey]
    );
    result.previousRuleBudgetId = prevRes.rows[0] ? prevRes.rows[0].budget_id : null;

    // 3. Set the merchant's rule: the new category, the restored one, or none.
    let targetRuleBudgetId = remember ? budgetId : restoreRuleBudgetId;
    if (targetRuleBudgetId !== null && targetRuleBudgetId !== budgetId) {
      const check = await client.query('SELECT id FROM budgets WHERE id = $1', [targetRuleBudgetId]);
      if (!check.rows[0]) targetRuleBudgetId = null; // that category no longer exists
    }

    if (targetRuleBudgetId !== null) {
      await client.query(
        `INSERT INTO merchant_rules (${ruleColumn}, budget_id)
         VALUES ($1, $2)
         ON CONFLICT (${ruleColumn})
         DO UPDATE SET budget_id = EXCLUDED.budget_id, updated_at = now()`,
        [ruleKey, targetRuleBudgetId]
      );
      ruleMap.set(ruleKey, targetRuleBudgetId);
      result.ruleSaved = true;
    } else {
      await client.query(`DELETE FROM merchant_rules WHERE ${ruleColumn} = $1`, [ruleKey]);
      ruleMap.delete(ruleKey);
    }

    // 4. Re-file this merchant's other auto-tagged charges, this month only.
    const merchantFilter = entityId
      ? 'merchant_entity_id = $3'
      : 'merchant_entity_id IS NULL AND lower(trim(merchant_name)) = $3';

    const othersRes = await client.query(
      `SELECT id, merchant_entity_id, merchant_name, provider_category,
              provider_category_primary, category_id, excluded
       FROM transactions
       WHERE category_source = 'auto'
         AND removed_at IS NULL
         AND id <> $1
         AND date >= date_trunc('month', now() AT TIME ZONE $2::text)::date
         AND date <  (date_trunc('month', now() AT TIME ZONE $2::text) + interval '1 month')::date
         AND ${merchantFilter}`,
      [txnId, timeZone, ruleKey]
    );

    for (const row of othersRes.rows) {
      const next = categorize(
        {
          merchantEntityId: row.merchant_entity_id,
          merchantName: row.merchant_name,
          categoryDetailed: row.provider_category,
          categoryPrimary: row.provider_category_primary,
        },
        rules
      );
      if (next.categoryId !== row.category_id || next.excluded !== row.excluded) {
        await client.query(
          `UPDATE transactions
           SET category_id = $1, excluded = $2, updated_at = now()
           WHERE id = $3`,
          [next.categoryId, next.excluded, row.id]
        );
        result.refiled += 1;
      }
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { retagTransaction };