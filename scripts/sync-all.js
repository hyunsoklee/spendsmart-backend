// scripts/sync-all.js
// Syncs every active connection. Run from the backend folder.

require('dotenv').config();
const pool = require('../db');
const { syncConnection } = require('../sync/syncConnection');

(async () => {
  try {
    const { rows } = await pool.query(
      `SELECT id, institution_name FROM connections WHERE status = 'active' ORDER BY id`
    );
    if (rows.length === 0) console.log('No active connections.');

    for (const c of rows) {
      const counts = await syncConnection(c.id);
      console.log(`✅ ${c.institution_name} (connection ${c.id}):`, counts);
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Sync failed:', err.response?.data || err.message);
    process.exit(1);
  }
})();