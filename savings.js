// savings.js
// Savings targets: a named goal, and a record of every change to it.
// The amount set aside is always the sum of the target's lines.
//
// Amounts are whole cents. A rehearsal (dryRun) does everything and then
// undoes it, so the answer is real but nothing is kept.

const pool = require('./db');

const NAME_MAX = 20;
const MAX_CENTS = 1000000000; // $10,000,000

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
}

function checkCents(value, what) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_CENTS) {
    throw httpError(400, `${what} must be between $0 and $10,000,000`);
  }
  return value;
}

function checkId(id) {
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, 'That target does not exist');
  return id;
}

async function inTransaction(dryRun, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { ...result, dryRun: Boolean(dryRun) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Two people adding the same name at the same moment.
    if (err.code === '23505') throw httpError(409, 'That name is already in use');
    throw err;
  } finally {
    client.release();
  }
}

// Targets in use, each with what is set aside and the category it shows on.
async function readTargets(db, where = '', params = []) {
  const { rows } = await db.query(
    `SELECT t.id, t.name, t.goal_cents, t.budget_id,
            b.category, b.icon,
            COALESCE(SUM(l.amount_cents), 0)::int AS saved_cents
     FROM savings_targets t
     LEFT JOIN budgets b ON b.id = t.budget_id
     LEFT JOIN savings_lines l ON l.target_id = t.id
     WHERE t.removed_at IS NULL ${where}
     GROUP BY t.id, b.id
     ORDER BY t.sort_order, t.id`,
    params
  );
  return rows;
}

async function readTarget(db, id) {
  const rows = await readTargets(db, 'AND t.id = $1', [checkId(id)]);
  if (rows.length === 0) throw httpError(404, 'That target does not exist');
  return rows[0];
}

// Holds the target until the transaction ends, so two changes at the same
// moment cannot both read the same balance.
async function lockTarget(client, id) {
  const { rows } = await client.query(
    'SELECT id FROM savings_targets WHERE id = $1 AND removed_at IS NULL FOR UPDATE',
    [checkId(id)]
  );
  if (rows.length === 0) throw httpError(404, 'That target does not exist');
}

async function checkNameFree(client, name, exceptId = null) {
  if (!name) throw httpError(400, 'A target needs a name');
  if (name.length > NAME_MAX) throw httpError(400, `A name can be up to ${NAME_MAX} characters`);
  const { rows } = await client.query(
    `SELECT 1 FROM savings_targets
     WHERE LOWER(name) = LOWER($1) AND removed_at IS NULL AND id IS DISTINCT FROM $2`,
    [name, exceptId]
  );
  if (rows.length > 0) throw httpError(409, 'That name is already in use');
}

async function checkBudget(client, budgetId) {
  if (budgetId === null) return null;
  if (!Number.isInteger(budgetId)) throw httpError(400, 'That category does not exist');
  const { rows } = await client.query('SELECT 1 FROM budgets WHERE id = $1', [budgetId]);
  if (rows.length === 0) throw httpError(400, 'That category does not exist');
  return budgetId;
}

function addLine(client, targetId, amountCents, kind, userId) {
  return client.query(
    'INSERT INTO savings_lines (target_id, amount_cents, kind, user_id) VALUES ($1, $2, $3, $4)',
    [targetId, amountCents, kind, Number.isInteger(userId) ? userId : null]
  );
}

async function listTargets() {
  return { targets: await readTargets(pool) };
}

async function createTarget({ name, goalCents, savedCents = 0, budgetId = null, userId = null, dryRun = false } = {}) {
  const cleaned = cleanName(name);
  checkCents(goalCents, 'The amount aimed for');
  checkCents(savedCents, 'The amount set aside');

  return inTransaction(dryRun, async (client) => {
    await checkNameFree(client, cleaned);
    await checkBudget(client, budgetId);

    const { rows } = await client.query(
      'INSERT INTO savings_targets (name, goal_cents, budget_id) VALUES ($1, $2, $3) RETURNING id',
      [cleaned, goalCents, budgetId]
    );
    const id = rows[0].id;

    // What was already set aside is the first line of the record.
    if (savedCents > 0) await addLine(client, id, savedCents, 'hand', userId);

    return readTarget(client, id);
  });
}

// Changes only what is sent. budgetId: null takes the target off its category.
async function updateTarget(id, { name, goalCents, budgetId, dryRun = false } = {}) {
  return inTransaction(dryRun, async (client) => {
    await lockTarget(client, id);

    if (name !== undefined) {
      const cleaned = cleanName(name);
      await checkNameFree(client, cleaned, id);
      await client.query('UPDATE savings_targets SET name = $1 WHERE id = $2', [cleaned, id]);
    }
    if (goalCents !== undefined) {
      checkCents(goalCents, 'The amount aimed for');
      await client.query('UPDATE savings_targets SET goal_cents = $1 WHERE id = $2', [goalCents, id]);
    }
    if (budgetId !== undefined) {
      await checkBudget(client, budgetId);
      await client.query('UPDATE savings_targets SET budget_id = $1 WHERE id = $2', [budgetId, id]);
    }

    return readTarget(client, id);
  });
}

// "Change amount set aside": the new total is given, and the difference
// becomes a line in the record.
async function setAmount(id, { savedCents, userId = null, dryRun = false } = {}) {
  checkCents(savedCents, 'The amount set aside');

  return inTransaction(dryRun, async (client) => {
    await lockTarget(client, id);
    const before = await readTarget(client, id);
    const changedBy = savedCents - before.saved_cents;

    if (changedBy !== 0) await addLine(client, id, changedBy, 'hand', userId);

    return { ...(await readTarget(client, id)), changedBy };
  });
}

// What is set aside goes to another target (moveToId), or leaves savings.
async function removeTarget(id, { moveToId = null, userId = null, dryRun = false } = {}) {
  return inTransaction(dryRun, async (client) => {
    await lockTarget(client, id);
    const target = await readTarget(client, id);
    let movedTo = null;

    if (target.saved_cents > 0) {
      if (moveToId !== null) {
        if (moveToId === id) throw httpError(400, 'Choose a different target');
        await lockTarget(client, moveToId);
        const other = await readTarget(client, moveToId);
        await addLine(client, id, -target.saved_cents, 'move', userId);
        await addLine(client, moveToId, target.saved_cents, 'move', userId);
        movedTo = { id: other.id, name: other.name };
      } else {
        await addLine(client, id, -target.saved_cents, 'hand', userId);
      }
    }

    await client.query('UPDATE savings_targets SET removed_at = now() WHERE id = $1', [id]);

    return { id: target.id, name: target.name, saved_cents: target.saved_cents, movedTo };
  });
}

module.exports = { listTargets, createTarget, updateTarget, setAmount, removeTarget, NAME_MAX };