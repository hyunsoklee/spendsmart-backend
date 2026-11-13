// spending.js
// Calculates this month's spending per budget from the transactions table.
// Used by /api/budgets and /api/summary so the two can never disagree.

const pool = require('./db');

// The household's home timezone decides when the month rolls over.
// Default for now; later this comes from a household setting.
const DEFAULT_TIME_ZONE = 'America/New_York';

async function getBudgetsWithSpent(timeZone = DEFAULT_TIME_ZONE) {
  const { rows } = await pool.query(
    `WITH month AS (
       SELECT date_trunc('month', now() AT TIME ZONE $1::text)::date AS start_date,
              (date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month')::date AS end_date
     )
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

module.exports = { getBudgetsWithSpent, DEFAULT_TIME_ZONE };