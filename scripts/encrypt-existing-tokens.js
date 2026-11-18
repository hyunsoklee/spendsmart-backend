// scripts/encrypt-existing-tokens.js
// One-time: encrypts any access tokens still stored as plain text.
// Safe to run again; rows that are already encrypted are left alone.
// Run from the backend folder: node scripts/encrypt-existing-tokens.js

const pool = require('../db');
const { encryptToken, isEncrypted } = require('../tokenCrypto');

(async () => {
  try {
    const { rows } = await pool.query('SELECT id, access_token FROM connections ORDER BY id');
    let changed = 0;

    for (const row of rows) {
      if (isEncrypted(row.access_token)) continue;
      await pool.query('UPDATE connections SET access_token = $1 WHERE id = $2', [
        encryptToken(row.access_token),
        row.id,
      ]);
      changed += 1;
    }

    console.log(`Connections: ${rows.length}. Newly encrypted: ${changed}.`);
  } catch (error) {
    // Print the message only, never a token.
    console.error('Failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();