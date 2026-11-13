// split.js
// Sets who a charge belongs to: one person, or Shared (null).
// A split applies to that one charge only. Future charges follow the
// card's default split, so no rule is saved here.

const pool = require('./db');

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function setTransactionSplit(txnId, splitUserId) {
  let splitName = null;

  if (splitUserId !== null) {
    const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [splitUserId]);
    if (!userRes.rows[0]) throw httpError(400, 'Unknown user');
    splitName = userRes.rows[0].name;
  }

  const { rows } = await pool.query(
    `UPDATE transactions
     SET split_user_id = $1, updated_at = now()
     WHERE id = $2 AND removed_at IS NULL
     RETURNING id`,
    [splitUserId, txnId]
  );
  if (!rows[0]) throw httpError(404, 'Transaction not found');

  return { transactionId: txnId, splitUserId, splitName };
}

async function listUsers() {
  const { rows } = await pool.query('SELECT id, name FROM users ORDER BY id');
  return rows;
}

module.exports = { setTransactionSplit, listUsers };