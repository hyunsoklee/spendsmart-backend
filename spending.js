// spending.js
// This month's spending, read from the transactions table.
// Used by the budget, summary, and transaction-list routes so they always agree.

const pool = require('./db');

// The household's home timezone decides when the month rolls over.
// Default for now; later this comes from a household setting.
const DEFAULT_TIME_ZONE = 'America/New_York';

// Shared definition of "this month": $1 is the timezone.
const MONTH_CTE = `
  WITH month AS (
    SELECT date_trunc('month', now() AT TIME ZONE $1::text)::date AS start_date,
           (date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month')::date AS end_date
  )`;

async function getBudgetsWithSpent(timeZone = DEFAULT_TIME_ZONE) {
  const { rows } = await pool.query(
    `${MONTH_CTE}
     SELECT b.id, b.category, b.budget, b.is_system,
            COALESCE(SUM(t.amount_cents), 0)::int AS spent_cents
     FROM budgets b
     CROSS JOIN month m
     LEFT JOIN transactions t
       ON t.category_id = b.id
      AND t.excluded = false          -- card payments and transfers don't count
      AND t.removed_at IS NULL        -- retracted charges don't count
      AND t.date >= m.start_date
      AND t.date <  m.end_date
     GROUP BY b.id
     ORDER BY b.id`,
    [timeZone]
  );

  // spent: whole dollars, the shape the app already expects.
  // spent_cents: exact amount, for screens that want precision later.
  return rows.map((r) => ({ ...r, spent: Math.round(r.spent_cents / 100) }));
}

// This month's charges in one budget category, newest first.
async function getCategoryTransactions(budgetId, timeZone = DEFAULT_TIME_ZONE) {
  const { rows } = await pool.query(
    `${MONTH_CTE}
     SELECT t.id,
            to_char(t.date, 'YYYY-MM-DD') AS date,
            COALESCE(t.merchant_name, t.raw_description, 'Unknown') AS merchant,
            t.amount_cents,
            t.pending,
            t.category_source,
            t.split_user_id,          -- null = Shared
            u.name AS split_name,     -- null = Shared
            a.name AS card_name,
            a.mask AS card_mask
     FROM transactions t
     CROSS JOIN month m
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN users u ON u.id = t.split_user_id
     WHERE t.category_id = $2
       AND t.excluded = false
       AND t.removed_at IS NULL
       AND t.date >= m.start_date
       AND t.date <  m.end_date
     ORDER BY t.date DESC, t.id DESC`,
    [timeZone, budgetId]
  );
  return rows;
}

module.exports = { getBudgetsWithSpent, getCategoryTransactions, DEFAULT_TIME_ZONE };