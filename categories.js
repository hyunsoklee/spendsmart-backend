// categories.js
// Creating a category of your own.
//
// A new category is: a name, an icon, a monthly budget, and optionally the
// kinds of charge that should file themselves there. Everything happens in
// one database transaction, so it either all happens or none of it does.
//
// What never changes: charges placed by hand, charges decided by a
// remembered merchant, and earlier months.

const pool = require('./db');
const { loadRules, categorize } = require('./sync/categorize');
const { DEFAULT_TIME_ZONE } = require('./spending');
const { listKinds } = require('./kinds');
const { suggestBudget, isAmount } = require('./setup');

const NAME_MAX = 20;
const MAX_KINDS = 40;

// Icons a new category can choose. Each comes with its own color in the app,
// so an icon can belong to only one category at a time.
const NEW_ICONS = [
  'smile', 'heart', 'paw', 'cup', 'gift', 'home',
  'book', 'dumbbell', 'repeat', 'scissors', 'star', 'phone',
];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// '  date   night ' -> 'date night'
function cleanName(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Turns a list of kind codes into the full entries from the kinds listing.
// Only kinds the listing offers can be chosen.
async function pickKinds(kindCodes, timeZone) {
  if (kindCodes === undefined || kindCodes === null) return [];
  if (!Array.isArray(kindCodes) || kindCodes.length > MAX_KINDS) {
    throw httpError(400, 'kinds must be a list');
  }
  const { kinds } = await listKinds(timeZone);
  const offered = new Map(kinds.map((k) => [k.kind, k]));
  const chosen = [];
  for (const code of new Set(kindCodes)) {
    const entry = typeof code === 'string' ? offered.get(code) : null;
    if (!entry) throw httpError(400, `Unknown kind: ${String(code).slice(0, 80)}`);
    chosen.push(entry);
  }
  return chosen;
}

// Where the new budget comes from by default:
//   nothing chosen               -> Other
//   all from one category        -> that category
//   several, Other among them    -> Other
//   several, none of them Other  -> nowhere (null)
function defaultSourceId(chosen, otherId) {
  const ids = [...new Set(chosen.map((k) => k.filedIn.id))];
  if (ids.length === 0) return otherId;
  if (ids.length === 1) return ids[0];
  return ids.includes(otherId) ? otherId : null;
}

// The starting point for the budget step: what these kinds came to last
// month, a suggested amount, and where the money would come from.
async function suggestForKinds(kindCodes, timeZone = DEFAULT_TIME_ZONE) {
  const chosen = await pickKinds(kindCodes, timeZone);
  const { rows: budgets } = await pool.query(
    'SELECT id, category, icon, budget, is_system FROM budgets ORDER BY id'
  );
  const other = budgets.find((b) => b.is_system);
  if (!other) throw new Error('No system category found.');

  const lastMonthCents = chosen.reduce((sum, k) => sum + k.lastMonthCents, 0);

  const sourceCounts = new Map();
  for (const k of chosen) {
    sourceCounts.set(k.filedIn.id, (sourceCounts.get(k.filedIn.id) || 0) + k.charges);
  }
  const describe = (b) => ({ id: b.id, category: b.category, icon: b.icon, isOther: b.is_system });

  const sourceId = defaultSourceId(chosen, other.id);
  const source = sourceId === null ? null : budgets.find((b) => b.id === sourceId);

  return {
    lastMonth: Math.max(0, Math.round(lastMonthCents / 100)),
    suggested: suggestBudget(lastMonthCents, 0),
    moving: {
      charges: chosen.reduce((sum, k) => sum + k.charges, 0),
      amount: chosen.reduce((sum, k) => sum + k.amount, 0),
    },
    sources: budgets
      .filter((b) => sourceCounts.has(b.id))
      .map((b) => ({ ...describe(b), charges: sourceCounts.get(b.id) })),
    takenFrom: source ? { ...describe(source), budget: Number(source.budget) } : null,
  };
}

// input: { name, icon, kinds, budget, takenFromId, sourceBecomes, dryRun }
//   takenFromId   the category the budget is taken from, or null for nowhere
//   sourceBecomes what that category keeps (default: its budget minus the new one)
//   dryRun        do everything, report it, then undo it all
async function createCategory(input, timeZone = DEFAULT_TIME_ZONE) {
  const {
    name: rawName,
    icon,
    kinds: kindCodes,
    budget,
    takenFromId = null,
    sourceBecomes,
    dryRun = false,
  } = input || {};

  const name = cleanName(rawName);
  if (!name || name.length > NAME_MAX) {
    throw httpError(400, `name must be 1 to ${NAME_MAX} characters`);
  }
  if (!NEW_ICONS.includes(icon)) throw httpError(400, 'Unknown icon');
  if (!isAmount(budget)) throw httpError(400, 'budget must be a whole number of dollars');
  if (takenFromId !== null && !Number.isInteger(takenFromId)) {
    throw httpError(400, 'takenFromId must be a category id or null');
  }
  if (sourceBecomes !== undefined && (takenFromId === null || !isAmount(sourceBecomes))) {
    throw httpError(400, 'sourceBecomes must be a whole number of dollars');
  }

  const chosen = await pickKinds(kindCodes, timeZone);
  // Saved rules, adjusted in memory below so re-filing sees the new ones.
  const rules = await loadRules();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    // One category change at a time.
    await client.query('LOCK TABLE budgets IN SHARE ROW EXCLUSIVE MODE');

    const { rows: existing } = await client.query('SELECT id, category, icon, budget FROM budgets');
    if (existing.some((b) => cleanName(b.category).toLowerCase() === name.toLowerCase())) {
      throw httpError(409, 'A category with that name already exists');
    }
    if (existing.some((b) => b.icon === icon)) {
      throw httpError(409, 'That icon is already in use');
    }

    let takenFrom = null;
    if (takenFromId !== null) {
      const source = existing.find((b) => b.id === takenFromId);
      if (!source) throw httpError(400, 'Unknown category to take from');
      const was = Number(source.budget);
      const becomes = sourceBecomes !== undefined ? sourceBecomes : Math.max(0, was - budget);
      if (becomes > was) {
        throw httpError(400, 'sourceBecomes cannot be more than that category has today');
      }
      takenFrom = { id: source.id, category: source.category, was, becomes };
    }

    // 1. The category itself.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('budgets', 'id'), (SELECT MAX(id) FROM budgets))`
    );
    const created = await client.query(
      `INSERT INTO budgets (category, budget, spent, is_system, icon)
       VALUES ($1, $2, 0, false, $3)
       RETURNING id`,
      [name, budget, icon]
    );
    const newId = created.rows[0].id;

    // 2. Its kinds. A kind that filed elsewhere now files here.
    for (const k of chosen) {
      await client.query(
        `INSERT INTO category_rules (plaid_category, budget_id, skip)
         VALUES ($1, $2, false)
         ON CONFLICT (plaid_category)
         DO UPDATE SET budget_id = EXCLUDED.budget_id, skip = false`,
        [k.kind, newId]
      );
      rules.byCategory.set(k.kind, { budgetId: newId, skip: false });
    }

    // 3. Where the money comes from.
    if (takenFrom) {
      await client.query('UPDATE budgets SET budget = $1 WHERE id = $2', [
        takenFrom.becomes,
        takenFrom.id,
      ]);
    }

    // 4. Re-file this month's automatically filed charges of those kinds.
    let moved = 0;
    if (chosen.length > 0) {
      const { rows } = await client.query(
        `SELECT id, merchant_entity_id, merchant_name, provider_category,
                provider_category_primary, category_id, excluded
         FROM transactions
         WHERE category_source = 'auto'
           AND removed_at IS NULL
           AND date >= date_trunc('month', now() AT TIME ZONE $1::text)::date
           AND date <  (date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month')::date
           AND provider_category = ANY($2::text[])`,
        [timeZone, chosen.map((k) => k.kind)]
      );
      for (const row of rows) {
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
          moved += 1;
        }
      }
    }

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    return {
      id: newId,
      category: name,
      icon,
      budget,
      kinds: chosen.map((k) => k.kind),
      moved,
      takenFrom,
      dryRun,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { createCategory, suggestForKinds, NEW_ICONS };