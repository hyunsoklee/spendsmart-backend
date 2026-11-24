// setup.js
// First-use setup: planned savings plus a budget for every category.
// Take-home income and spending not on cards are deliberately absent:
// those two numbers stay on the phone and are never sent to this server.

const pool = require('./db');
const { DEFAULT_TIME_ZONE } = require('./spending');

const ROUND_TO = 50; // suggested budgets round up to the nearest $50
const MAX_AMOUNT = 1000000; // sanity ceiling for any single amount, in dollars

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// A whole number of dollars, 0 or more.
function isAmount(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_AMOUNT;
}

// Last month's spending rounded up to the nearest $50.
// With no spending last month, keep the budget that is already set.
function suggestBudget(lastMonthCents, currentBudget) {
  if (lastMonthCents <= 0) return currentBudget;
  return Math.ceil(lastMonthCents / 100 / ROUND_TO) * ROUND_TO;
}

// Everything the setup screens need, in one call.
async function getSetup(timeZone = DEFAULT_TIME_ZONE) {
  const [settingsRes, budgetsRes] = await Promise.all([
    pool.query('SELECT planned_savings, setup_completed_at FROM household_settings WHERE id = 1'),
    pool.query(
      `WITH month AS (
         SELECT (date_trunc('month', now() AT TIME ZONE $1::text) - interval '1 month')::date AS start_date,
                date_trunc('month', now() AT TIME ZONE $1::text)::date AS end_date
       )
       SELECT b.id, b.category, b.budget, b.is_system, b.icon,
              to_char(m.start_date, 'Mon') AS month_label,
              COALESCE(SUM(t.amount_cents), 0)::int AS last_month_cents
       FROM budgets b
       CROSS JOIN month m
       LEFT JOIN transactions t
         ON t.category_id = b.id
        AND t.excluded = false          -- card payments and transfers do not count
        AND t.removed_at IS NULL        -- retracted charges do not count
        AND t.date >= m.start_date
        AND t.date <  m.end_date
       GROUP BY b.id, m.start_date
       ORDER BY b.is_system, b.sort_order, b.id`,
      [timeZone]
    ),
  ]);

  const settings = settingsRes.rows[0];
  if (!settings) {
    throw new Error('No household_settings row found. Was migration 004 run?');
  }

  return {
    plannedSavings: settings.planned_savings,
    setupCompleted: settings.setup_completed_at !== null,
    lastMonthLabel: budgetsRes.rows[0] ? budgetsRes.rows[0].month_label : null,
    budgets: budgetsRes.rows.map((r) => ({
      id: r.id,
      category: r.category,
      icon: r.icon,
      budget: r.budget,
      is_system: r.is_system,
      lastMonthSpent: Math.max(0, Math.round(r.last_month_cents / 100)),
      suggested: suggestBudget(r.last_month_cents, r.budget),
    })),
  };
}

// Saves planned savings and every budget in the list together.
// If anything is invalid, nothing is saved.
async function saveSetup(input, timeZone = DEFAULT_TIME_ZONE) {
  const { plannedSavings, budgets } = input || {};

  if (!isAmount(plannedSavings)) {
    throw httpError(400, 'plannedSavings must be a whole number of dollars, 0 or more');
  }
  if (!Array.isArray(budgets) || budgets.length === 0) {
    throw httpError(400, 'budgets must be a list with at least one entry');
  }
  for (const b of budgets) {
    if (!b || !Number.isInteger(b.id) || !isAmount(b.budget)) {
      throw httpError(400, 'Each budget needs an id and a whole-dollar amount, 0 or more');
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const b of budgets) {
      const res = await client.query('UPDATE budgets SET budget = $1 WHERE id = $2', [b.budget, b.id]);
      if (res.rowCount === 0) throw httpError(400, `Unknown budget id ${b.id}`);
    }

    const settingsRes = await client.query(
      `UPDATE household_settings
       SET planned_savings = $1,
           setup_completed_at = COALESCE(setup_completed_at, now()),
           updated_at = now()
       WHERE id = 1`,
      [plannedSavings]
    );
    if (settingsRes.rowCount === 0) {
      throw new Error('No household_settings row found. Was migration 004 run?');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return getSetup(timeZone);
}

module.exports = { getSetup, saveSetup, suggestBudget, isAmount };