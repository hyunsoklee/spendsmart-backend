// syncAll.js
// Fetches new charges from every linked bank, unless that was done recently.
// Only one fetch runs at a time, however many phones ask.

const pool = require('./db');
const { syncConnection } = require('./sync/syncConnection');

// Never fetch more often than this, even when asked to.
const FLOOR_MINUTES = 1;

let running = null; // the fetch in progress, if any

// How fresh the numbers are: the least recently fetched bank decides.
// null means there are no banks, or one has never been fetched.
async function getFreshness() {
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS banks,
            COUNT(last_synced_at) AS fetched_before,
            MIN(last_synced_at) AS oldest
     FROM connections
     WHERE status = 'active'`
  );
  const banks = Number(rows[0].banks);
  const everyBankFetched = banks > 0 && Number(rows[0].fetched_before) === banks;
  return {
    banks,
    lastSyncedAt: everyBankFetched ? rows[0].oldest : null,
  };
}

async function fetchEveryBank() {
  const { rows } = await pool.query(
    `SELECT id, institution_name FROM connections WHERE status = 'active' ORDER BY id`
  );
  let failed = 0;
  for (const c of rows) {
    try {
      await syncConnection(c.id);
    } catch (err) {
      // One bank failing must not stop the others. Its "last fetched" time
      // stays old, so the app shows the numbers as stale. Never log a token.
      failed += 1;
      const plaidError = err.response && err.response.data;
      console.error(
        `Could not fetch ${c.institution_name}:`,
        plaidError ? `${plaidError.error_code}: ${plaidError.error_message}` : err.message
      );
    }
  }
  return { failed };
}

// Fetches if the numbers are older than `ifOlderThanMinutes`.
// Returns { fetched, banks, failed, lastSyncedAt }.
async function refreshFromBanks(ifOlderThanMinutes) {
  const limit = Math.max(FLOOR_MINUTES, Number(ifOlderThanMinutes) || 0);
  const before = await getFreshness();

  if (before.banks === 0) {
    return { fetched: false, banks: 0, failed: 0, lastSyncedAt: null };
  }

  const ageMinutes = before.lastSyncedAt
    ? (Date.now() - new Date(before.lastSyncedAt).getTime()) / 60000
    : Infinity;

  if (ageMinutes < limit && !running) {
    return { fetched: false, banks: before.banks, failed: 0, lastSyncedAt: before.lastSyncedAt };
  }

  // Join the fetch already in progress, or start one.
  if (!running) {
    running = fetchEveryBank().finally(() => {
      running = null;
    });
  }
  const { failed } = await running;

  const after = await getFreshness();
  return { fetched: true, banks: after.banks, failed, lastSyncedAt: after.lastSyncedAt };
}

module.exports = { refreshFromBanks };