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
const { listKinds, labelForKind, groupOfKind } = require('./kinds');
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
  const { kinds } = await listKinds(timeZone, {
    include: kindCodes.filter((code) => typeof code === 'string'),
  });
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
    const thisMonthCents = chosen.reduce((sum, k) => sum + k.amountCents, 0);

  const sourceCounts = new Map();
  for (const k of chosen) {
    sourceCounts.set(k.filedIn.id, (sourceCounts.get(k.filedIn.id) || 0) + k.charges);
  }
  const describe = (b) => ({ id: b.id, category: b.category, icon: b.icon, isOther: b.is_system });

  const sourceId = defaultSourceId(chosen, other.id);
  const source = sourceId === null ? null : budgets.find((b) => b.id === sourceId);

  return {
    lastMonth: Math.max(0, Math.round(lastMonthCents / 100)),
    suggested: suggestBudget(Math.max(lastMonthCents, thisMonthCents), 0),
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

// Icons any category except Other may switch to, if no other category has it.
const CHOOSABLE_ICONS = [
  'groceries', 'dining', 'shopping', 'entertainment', 'travel', 'transportation',
  ...NEW_ICONS,
];

// Rename a category, change its icon, or both.
// Charges and rules follow the category by its number, so nothing else moves.
// input: { name, icon, dryRun }
async function updateCategory(id, input) {
  const { name: rawName, icon, dryRun = false } = input || {};
  if (!Number.isInteger(id)) throw httpError(400, 'Unknown category');
  if (rawName === undefined && icon === undefined) throw httpError(400, 'Nothing to change');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE budgets IN SHARE ROW EXCLUSIVE MODE');

    const { rows: all } = await client.query('SELECT id, category, icon, is_system FROM budgets');
    const current = all.find((b) => b.id === id);
    if (!current) throw httpError(404, 'Category not found');
    const others = all.filter((b) => b.id !== id);

    let name = current.category;
    if (rawName !== undefined) {
      name = cleanName(rawName);
      if (!name || name.length > NAME_MAX) {
        throw httpError(400, `name must be 1 to ${NAME_MAX} characters`);
      }
      if (others.some((b) => cleanName(b.category).toLowerCase() === name.toLowerCase())) {
        throw httpError(409, 'A category with that name already exists');
      }
    }

    let nextIcon = current.icon;
    if (icon !== undefined && icon !== current.icon) {
      if (current.is_system) throw httpError(400, 'This category keeps its icon');
      if (!CHOOSABLE_ICONS.includes(icon)) throw httpError(400, 'Unknown icon');
      if (others.some((b) => b.icon === icon)) throw httpError(409, 'That icon is already in use');
      nextIcon = icon;
    }

    await client.query('UPDATE budgets SET category = $1, icon = $2 WHERE id = $3', [
      name,
      nextIcon,
      id,
    ]);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { id, category: name, icon: nextIcon, dryRun };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Forget every rule that points at a category, in memory only.
// Returns the kinds that filed there by rule.
function forgetCategory(rules, id) {
  const kinds = [];
  for (const [kind, rule] of rules.byCategory) {
    if (rule.budgetId === id) {
      kinds.push(kind);
      rules.byCategory.delete(kind);
    }
  }
  for (const [key, budgetId] of rules.byMerchantId) {
    if (budgetId === id) rules.byMerchantId.delete(key);
  }
  for (const [key, budgetId] of rules.byMerchantName) {
    if (budgetId === id) rules.byMerchantName.delete(key);
  }
  return kinds;
}

// What removing a category would do, worked out without changing anything:
// this month's charges by kind and where each would land, the kinds that
// file here by rule even with no charges this month, and the budget.
async function previewRemoveCategory(id, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isInteger(id)) throw httpError(400, 'Unknown category');

  const rules = await loadRules();
  const { rows: all } = await pool.query(
    'SELECT id, category, icon, budget, is_system FROM budgets ORDER BY is_system, id'
  );
  const target = all.find((b) => b.id === id);
  if (!target) throw httpError(404, 'Category not found');
  if (target.is_system) throw httpError(400, 'This category cannot be removed');
  const other = all.find((b) => b.is_system);
  if (!other) throw new Error('No system category found.');

  const byId = new Map(all.map((b) => [b.id, b]));
  const describe = (b) => ({ id: b.id, category: b.category, icon: b.icon, isOther: b.is_system });

  // The rules as they will be once this category is gone.
  const ruledKinds = forgetCategory(rules, id);

  // Where a charge of this kind would land. null means "not counted as spending".
  const landing = (kind, group, row) => {
    const next = categorize(
      {
        merchantEntityId: row ? row.merchant_entity_id : null,
        merchantName: row ? row.merchant_name : null,
        categoryDetailed: kind,
        categoryPrimary: group,
      },
      rules
    );
    return next.excluded ? null : describe(byId.get(next.categoryId) || other);
  };

  const { rows } = await pool.query(
    `SELECT merchant_entity_id, merchant_name, provider_category,
            provider_category_primary, amount_cents, category_source
     FROM transactions
     WHERE category_id = $1
       AND removed_at IS NULL
       AND date >= date_trunc('month', now() AT TIME ZONE $2::text)::date
       AND date <  (date_trunc('month', now() AT TIME ZONE $2::text) + interval '1 month')::date`,
    [id, timeZone]
  );

  const groups = new Map();
  const add = (key, label, to, cents) => {
    let g = groups.get(key);
    if (!g) {
      g = { label, to, charges: 0, cents: 0 };
      groups.set(key, g);
    }
    g.charges += 1;
    g.cents += cents;
  };

  for (const row of rows) {
    if (row.category_source === 'user') {
      add('hand', 'Placed by hand', describe(other), row.amount_cents);
      continue;
    }
    const kind = row.provider_category;
    const group = row.provider_category_primary;
    const to = landing(kind, group, row);
    const label = kind ? labelForKind(kind, group) : 'Unlabelled charges';
    add(`${kind}|${to ? to.id : 'none'}`, label, to, row.amount_cents);
  }

  // Kinds that file here by rule but have no charges this month.
  for (const kind of ruledKinds) {
    if ([...groups.keys()].some((key) => key.startsWith(`${kind}|`))) continue;
    const group = groupOfKind(kind);
    groups.set(`${kind}|rule`, {
      label: labelForKind(kind, group),
      to: landing(kind === group ? null : kind, group, null),
      charges: 0,
      cents: 0,
    });
  }

  const moves = [...groups.values()]
    .map((g) => ({
      label: g.label,
      charges: g.charges,
      amount: Math.round(g.cents / 100),
      to: g.to,
    }))
    .sort((a, b) => b.amount - a.amount || b.charges - a.charges);

  return {
    id,
    category: target.category,
    icon: target.icon,
    budget: Number(target.budget),
    moves,
    returnTo: { ...describe(other), budget: Number(other.budget) },
  };
}

// Remove a category.
//   - Automatically filed charges go where the remaining rules put them.
//   - Charges placed by hand go to Other.
//   - Its budget goes back to Other, or to returnToId if given, or is
//     dropped from the total when dropBudget is true.
// Other itself cannot be removed.
// input: { returnToId, dropBudget, dryRun }
async function removeCategory(id, input) {
  const { returnToId, dropBudget = false, dryRun = false } = input || {};
  if (!Number.isInteger(id)) throw httpError(400, 'Unknown category');
  const hasReturnTo = returnToId !== undefined && returnToId !== null;
  if (hasReturnTo && !Number.isInteger(returnToId)) {
    throw httpError(400, 'returnToId must be a category id');
  }

  const rules = await loadRules();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE budgets IN SHARE ROW EXCLUSIVE MODE');

    const { rows: all } = await client.query('SELECT id, category, budget, is_system FROM budgets');
    const target = all.find((b) => b.id === id);
    if (!target) throw httpError(404, 'Category not found');
    if (target.is_system) throw httpError(400, 'This category cannot be removed');
    const other = all.find((b) => b.is_system);
    if (!other) throw new Error('No system category found.');
    const returnTo = dropBudget
      ? null
      : hasReturnTo
      ? all.find((b) => b.id === returnToId)
      : other;
    if (!dropBudget && (!returnTo || returnTo.id === id)) {
      throw httpError(400, 'Unknown category to return the budget to');
    }

    // The rules as they will be once this category is gone.
    forgetCategory(rules, id);

    // 1. Charges placed by hand go to Other, and stay marked as placed by hand.
    const hand = await client.query(
      `UPDATE transactions
       SET category_id = $1, updated_at = now()
       WHERE category_id = $2 AND category_source = 'user'`,
      [other.id, id]
    );

    // 2. Automatically filed charges go where the remaining rules put them.
    const { rows } = await client.query(
      `SELECT id, merchant_entity_id, merchant_name, provider_category, provider_category_primary
       FROM transactions
       WHERE category_id = $1 AND category_source = 'auto'`,
      [id]
    );
    const groups = new Map(); // one update per destination
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
      const key = `${next.categoryId}|${next.excluded}`;
      if (!groups.has(key)) {
        groups.set(key, { categoryId: next.categoryId, excluded: next.excluded, ids: [] });
      }
      groups.get(key).ids.push(row.id);
    }
    for (const g of groups.values()) {
      await client.query(
        `UPDATE transactions
         SET category_id = $1, excluded = $2, updated_at = now()
         WHERE id = ANY($3)`,
        [g.categoryId, g.excluded, g.ids]
      );
    }

    // 3. Its budget goes back, unless it is being dropped from the total.
    let returnedTo = null;
    if (returnTo) {
      const was = Number(returnTo.budget);
      const becomes = was + Number(target.budget);
      await client.query('UPDATE budgets SET budget = $1 WHERE id = $2', [becomes, returnTo.id]);
      returnedTo = { id: returnTo.id, category: returnTo.category, was, becomes };
    }

    // 4. The category itself. Its rules go with it.
    await client.query('DELETE FROM budgets WHERE id = $1', [id]);

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

    return {
      id,
      category: target.category,
      budget: Number(target.budget),
      returnedTo,
      moved: { byRules: rows.length, toOther: hand.rowCount },
      dryRun,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Save the household's order for categories: first in the list shows first.
// Other is not part of it and always shows last.
async function saveCategoryOrder(ids) {
  const valid =
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.length <= 100 &&
    ids.every(Number.isInteger) &&
    new Set(ids).size === ids.length;
  if (!valid) throw httpError(400, 'ids must be a list of category ids');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < ids.length; i += 1) {
      await client.query('UPDATE budgets SET sort_order = $1 WHERE id = $2', [i + 1, ids[i]]);
    }
    await client.query('COMMIT');
    return { saved: ids.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Re-file this month's automatically filed charges of the given kinds,
// following the rules as they now stand. Returns how many moved.
async function refileThisMonth(client, rules, kindCodes, timeZone) {
  if (kindCodes.length === 0) return 0;
  const { rows } = await client.query(
    `SELECT id, merchant_entity_id, merchant_name, provider_category,
            provider_category_primary, category_id, excluded
     FROM transactions
     WHERE category_source = 'auto'
       AND removed_at IS NULL
       AND date >= date_trunc('month', now() AT TIME ZONE $1::text)::date
       AND date <  (date_trunc('month', now() AT TIME ZONE $1::text) + interval '1 month')::date
       AND provider_category = ANY($2::text[])`,
    [timeZone, kindCodes]
  );
  let moved = 0;
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
  return moved;
}

// The kinds a category could hold: the ones that file there today and the
// rest, each with where it would go if it did not belong here.
async function listCategoryKinds(id, timeZone = DEFAULT_TIME_ZONE) {
  if (!Number.isInteger(id)) throw httpError(400, 'Unknown category');

  const [{ kinds }, rules, budgetsRes] = await Promise.all([
    listKinds(timeZone),
    loadRules(),
    pool.query('SELECT id, category, icon, is_system FROM budgets'),
  ]);
  const all = budgetsRes.rows;
  const target = all.find((b) => b.id === id);
  if (!target) throw httpError(404, 'Category not found');
  if (target.is_system) throw httpError(400, 'This category takes whatever has no other place');
  const other = all.find((b) => b.is_system);
  if (!other) throw new Error('No system category found.');

  const byId = new Map(all.map((b) => [b.id, b]));
  const describe = (b) => ({ id: b.id, category: b.category, icon: b.icon, isOther: b.is_system });

  // Where a kind would go if it did not belong here: its broad group's
  // category, unless that is this one, in which case Other.
  // null means "not counted as spending".
  const elsewhereFor = (kind) => {
    const group = groupOfKind(kind);
    const broad = group ? rules.byCategory.get(group) : null;
    if (broad && broad.skip) return null;
    const to = broad && broad.budgetId !== id ? byId.get(broad.budgetId) : null;
    return describe(to || other);
  };

  const rows = kinds.map((k) => ({
    kind: k.kind,
    label: k.label,
    charges: k.charges,
    amount: k.amount,
    belongs: k.filedIn.id === id,
    filedIn: k.filedIn,
    elsewhere: elsewhereFor(k.kind),
  }));

  // Kinds that file here by a rule of their own but have had no charges lately.
  const seen = new Set(rows.map((r) => r.kind));
  for (const [kind, rule] of rules.byCategory) {
    if (rule.budgetId !== id || seen.has(kind)) continue;
    const group = groupOfKind(kind);
    if (kind === group) continue; // a broad group, not a kind
    rows.push({
      kind,
      label: labelForKind(kind, group),
      charges: 0,
      amount: 0,
      belongs: true,
      filedIn: describe(target),
      elsewhere: elsewhereFor(kind),
    });
  }

  return { id, category: target.category, kinds: rows };
}

// Set which kinds belong in a category. "kinds" is the full list wanted.
//   - A kind brought in files here from now on.
//   - A kind sent away goes back to its broad group's category, or to Other
//     when the broad group is this very category.
// This month's automatically filed charges of the changed kinds are re-filed.
// input: { kinds, dryRun }
async function setCategoryKinds(id, input, timeZone = DEFAULT_TIME_ZONE) {
  const { kinds: wanted, dryRun = false } = input || {};
  const valid =
    Array.isArray(wanted) && wanted.length <= 200 && wanted.every((k) => typeof k === 'string');
  if (!valid) throw httpError(400, 'kinds must be a list');

  // This also checks that the category exists and is not Other.
  const offered = (await listCategoryKinds(id, timeZone)).kinds;
  const offeredCodes = new Set(offered.map((k) => k.kind));
  for (const code of wanted) {
    if (!offeredCodes.has(code)) throw httpError(400, `Unknown kind: ${code.slice(0, 80)}`);
  }
  const want = new Set(wanted);

  const rules = await loadRules();
  // What the kind alone would decide. Shares the kind rules with "rules".
  const kindRulesOnly = { ...rules, byMerchantId: new Map(), byMerchantName: new Map() };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE budgets IN SHARE ROW EXCLUSIVE MODE');

    const setRule = async (kind, budgetId) => {
      await client.query(
        `INSERT INTO category_rules (plaid_category, budget_id, skip)
         VALUES ($1, $2, false)
         ON CONFLICT (plaid_category)
         DO UPDATE SET budget_id = EXCLUDED.budget_id, skip = false`,
        [kind, budgetId]
      );
      rules.byCategory.set(kind, { budgetId, skip: false });
    };

    const added = [];
    const removed = [];
    for (const k of offered) {
      const here = want.has(k.kind);

      if (here && !k.belongs) {
        await setRule(k.kind, id);
        added.push(k.kind);
      }

      if (!here && k.belongs) {
        const own = rules.byCategory.get(k.kind);
        if (own && own.budgetId === id) {
          await client.query('DELETE FROM category_rules WHERE plaid_category = $1', [k.kind]);
          rules.byCategory.delete(k.kind);
        }
        // Still landing here through its broad group: record the exception.
        const next = categorize(
          { categoryDetailed: k.kind, categoryPrimary: groupOfKind(k.kind) },
          kindRulesOnly
        );
        if (!next.excluded && next.categoryId === id) await setRule(k.kind, rules.otherId);
        removed.push(k.kind);
      }
    }

    const moved = await refileThisMonth(client, rules, [...added, ...removed], timeZone);

    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { id, added, removed, moved, dryRun };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  createCategory,
  suggestForKinds,
  updateCategory,
  removeCategory,
  previewRemoveCategory,
  saveCategoryOrder,
  listCategoryKinds,
  setCategoryKinds,
  NEW_ICONS,
  CHOOSABLE_ICONS,
};