// linking.js
// Links a bank and records the connection and its cards.
// Used only by the link page, which is served only to this Mac.

const pool = require('./db');
const adapter = require('./sync/plaidAdapter');
const { encryptToken } = require('./tokenCrypto');
const { syncConnection } = require('./sync/syncConnection');

// An error the page can show as a plain message, with a status code.
function pageError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

async function listPeople() {
  const { rows } = await pool.query('SELECT * FROM users ORDER BY id');
  return rows.map((u) => ({ id: u.id, name: u.name || `User ${u.id}` }));
}

// Everything the link page shows: people, linked banks, their cards.
async function getLinkStatus() {
  const people = await listPeople();
  const conns = await pool.query(
    `SELECT id, user_id, institution_id, institution_name, status, last_synced_at
     FROM connections ORDER BY id`
  );
  const cards = await pool.query(
    `SELECT id, connection_id, name, mask, default_split_user_id
     FROM accounts ORDER BY id`
  );
  const charges = await pool.query(
    `SELECT a.connection_id, COUNT(*) AS count
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.removed_at IS NULL
     GROUP BY a.connection_id`
  );

  const chargeCount = new Map(charges.rows.map((r) => [r.connection_id, Number(r.count)]));

  return {
    environment: process.env.PLAID_ENV,
    people,
    connections: conns.rows.map((c) => ({
      id: c.id,
      userId: c.user_id,
      institutionId: c.institution_id,
      institutionName: c.institution_name,
      status: c.status,
      lastSyncedAt: c.last_synced_at,
      charges: chargeCount.get(c.id) || 0,
      cards: cards.rows
        .filter((a) => a.connection_id === c.id)
        .map((a) => ({
          id: a.id,
          name: a.name,
          mask: a.mask,
          defaultSplitUserId: a.default_split_user_id,
        })),
    })),
  };
}

async function requirePerson(userId) {
  const people = await listPeople();
  if (!people.some((p) => p.id === userId)) {
    throw pageError(400, 'Choose whose login this is.');
  }
}

async function createLinkToken(userId) {
  await requirePerson(userId);
  return adapter.createLinkToken(userId);
}

// Phase 1: save the new connection and its cards. No charges are fetched yet,
// so each card's default split can be chosen first.
async function startConnection({ userId, publicToken, institutionId, institutionName, allowDuplicate }) {
  await requirePerson(userId);
  if (typeof publicToken !== 'string' || publicToken === '') {
    throw pageError(400, 'The sign-in did not finish. Please try again.');
  }

  if (institutionId && !allowDuplicate) {
    const dup = await pool.query(
      `SELECT 1 FROM connections
       WHERE provider = $1 AND institution_id = $2 AND status <> 'disconnected'
       LIMIT 1`,
      [adapter.PROVIDER, institutionId]
    );
    if (dup.rows.length > 0) {
      throw pageError(409, 'This bank is already linked.', 'ALREADY_LINKED');
    }
  }

  const { accessToken, itemId } = await adapter.exchangePublicToken(publicToken);

  let connectionId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO connections
         (user_id, provider, provider_item_id, institution_id, institution_name, access_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        userId,
        adapter.PROVIDER,
        itemId,
        institutionId || null,
        String(institutionName || 'Unknown bank').slice(0, 100),
        encryptToken(accessToken),
      ]
    );
    connectionId = rows[0].id;
  } catch (err) {
    // The item id is not a secret. It identifies the connection in Plaid's dashboard.
    throw pageError(
      500,
      `The bank was linked at Plaid (item ${itemId}) but could not be saved here: ${err.message}`
    );
  }

  const cards = await adapter.listCardAccounts(accessToken);
  for (const c of cards) {
    await pool.query(
      `INSERT INTO accounts (connection_id, provider_account_id, name, mask)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (connection_id, provider_account_id)
       DO UPDATE SET name = EXCLUDED.name, mask = EXCLUDED.mask`,
      [connectionId, c.providerAccountId, c.name, c.mask]
    );
  }

  return { connectionId, cards: cards.length };
}

// The split a card's new charges start with. null = Shared.
async function setCardDefaultSplit(accountId, splitUserId) {
  if (splitUserId !== null) await requirePerson(splitUserId);
  const res = await pool.query(
    'UPDATE accounts SET default_split_user_id = $1 WHERE id = $2',
    [splitUserId, accountId]
  );
  if (res.rowCount === 0) throw pageError(404, 'Card not found.');
}

// Phase 2, and any later refresh: fetch charges for one linked bank.
async function fetchCharges(connectionId) {
  const found = await pool.query('SELECT 1 FROM connections WHERE id = $1', [connectionId]);
  if (found.rows.length === 0) throw pageError(404, 'Linked bank not found.');
  return syncConnection(connectionId);
}

module.exports = {
  getLinkStatus,
  createLinkToken,
  startConnection,
  setCardDefaultSplit,
  fetchCharges,
};