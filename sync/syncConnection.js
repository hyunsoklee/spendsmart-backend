// sync/syncConnection.js
// Pulls changes for one connection and files them into our tables.
// Everything in step 3-5 runs in one DB transaction: all or nothing.

const pool = require('../db');
const { loadRules, categorize } = require('./categorize');

// One adapter per provider. Teller or SimpleFIN would be added here.
const adapters = {
  plaid: require('./plaidAdapter'),
};

async function syncConnection(connectionId) {
  const connRes = await pool.query('SELECT * FROM connections WHERE id = $1', [connectionId]);
  const conn = connRes.rows[0];
  if (!conn) throw new Error(`Connection ${connectionId} not found`);

  const adapter = adapters[conn.provider];
  if (!adapter) throw new Error(`No adapter for provider "${conn.provider}"`);

  // 1. Card accounts: insert new ones, refresh names on existing ones.
  const cards = await adapter.listCardAccounts(conn.access_token);
  const accountByProviderId = new Map();
  for (const c of cards) {
    const { rows } = await pool.query(
      `INSERT INTO accounts (connection_id, provider_account_id, name, mask)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (connection_id, provider_account_id)
       DO UPDATE SET name = EXCLUDED.name, mask = EXCLUDED.mask
       RETURNING id, provider_account_id, default_split_user_id`,
      [conn.id, c.providerAccountId, c.name, c.mask]
    );
    accountByProviderId.set(rows[0].provider_account_id, rows[0]);
  }

  // 2. Changes since the last sync, plus the current rules.
  const { added, modified, removed, nextCursor } = await adapter.fetchChanges(
    conn.access_token,
    conn.sync_cursor
  );
  const rules = await loadRules();

  const counts = { added: 0, modified: 0, removed: 0, skippedNonCard: 0 };
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 3. Insert or update each charge.
    for (const t of [...added, ...modified]) {
      const acct = accountByProviderId.get(t.providerAccountId);
      if (!acct) {
        counts.skippedNonCard += 1; // checking, savings, loans: not our business
        continue;
      }

      let { categoryId, excluded } = categorize(t, rules);
      let categorySource = 'auto';
      let splitUserId = acct.default_split_user_id;
      let pendingOfId = null;

      // Pending -> posted: inherit any edits made to the pending version.
      if (t.pendingOfProviderTxnId) {
        const prev = await client.query(
          `SELECT id, category_id, category_source, split_user_id
           FROM transactions WHERE provider = $1 AND provider_txn_id = $2`,
          [adapter.PROVIDER, t.pendingOfProviderTxnId]
        );
        if (prev.rows[0]) {
          pendingOfId = prev.rows[0].id;
          splitUserId = prev.rows[0].split_user_id;
          if (prev.rows[0].category_source === 'user') {
            categoryId = prev.rows[0].category_id;
            categorySource = 'user';
            excluded = false;
          }
        }
      }

      const { rows } = await client.query(
        `INSERT INTO transactions
           (account_id, provider, provider_txn_id, amount_cents, currency, date,
            authorized_date, merchant_name, raw_description, provider_category,
            account_owner_raw, category_id, category_source, pending, pending_of_id,
            split_user_id, excluded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (provider, provider_txn_id) DO UPDATE SET
           amount_cents      = EXCLUDED.amount_cents,
           date              = EXCLUDED.date,
           authorized_date   = EXCLUDED.authorized_date,
           merchant_name     = EXCLUDED.merchant_name,
           raw_description   = EXCLUDED.raw_description,
           provider_category = EXCLUDED.provider_category,
           account_owner_raw = EXCLUDED.account_owner_raw,
           pending           = EXCLUDED.pending,
           pending_of_id     = COALESCE(EXCLUDED.pending_of_id, transactions.pending_of_id),
           -- Rung 1: a hand-tagged row keeps its category.
           category_id       = CASE WHEN transactions.category_source = 'user'
                                    THEN transactions.category_id
                                    ELSE EXCLUDED.category_id END,
           excluded          = CASE WHEN transactions.category_source = 'user'
                                    THEN transactions.excluded
                                    ELSE EXCLUDED.excluded END,
           updated_at        = now()
         RETURNING (xmax = 0) AS inserted`,
        [
          acct.id, adapter.PROVIDER, t.providerTxnId, t.amountCents, t.currency, t.date,
          t.authorizedDate, t.merchantName, t.rawDescription,
          t.categoryDetailed || t.categoryPrimary, t.accountOwnerRaw,
          categoryId, categorySource, t.pending, pendingOfId, splitUserId, excluded,
        ]
      );
      if (rows[0].inserted) counts.added += 1;
      else counts.modified += 1;
    }

    // 4. Soft-delete removed charges (including pending ones that posted).
    for (const providerTxnId of removed) {
      const res = await client.query(
        `UPDATE transactions SET removed_at = now(), updated_at = now()
         WHERE provider = $1 AND provider_txn_id = $2 AND removed_at IS NULL`,
        [adapter.PROVIDER, providerTxnId]
      );
      counts.removed += res.rowCount;
    }

    // 5. Advance the cursor only once everything above succeeded.
    await client.query(
      `UPDATE connections SET sync_cursor = $1, last_synced_at = now(), status = 'active'
       WHERE id = $2`,
      [nextCursor, conn.id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return counts;
}

module.exports = { syncConnection };