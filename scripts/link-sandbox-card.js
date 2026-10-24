// scripts/link-sandbox-card.js
// Links a Plaid Sandbox bank and saves the connection to the database.
// Run from the backend folder: node scripts/link-sandbox-card.js

require('dotenv').config();
const plaid = require('../plaidClient');
const pool = require('../db');

const USER_ID = 1; // Hyun, from the users table

(async () => {
  try {
    const { data: created } = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508', // First Platypus Bank (Sandbox)
      initial_products: ['transactions'],
    });

    const { data: exchanged } = await plaid.itemPublicTokenExchange({
      public_token: created.public_token,
    });

    const { rows } = await pool.query(
      `INSERT INTO connections (user_id, provider, provider_item_id, institution_name, access_token)
       VALUES ($1, 'plaid', $2, $3, $4)
       RETURNING id`,
      [USER_ID, exchanged.item_id, 'First Platypus Bank (Sandbox)', exchanged.access_token]
    );

    console.log(`✅ Saved connection id ${rows[0].id}. Now run: node scripts/sync-all.js`);
    process.exit(0);
  } catch (err) {
    console.error('❌ Link failed:', err.response?.data || err.message);
    process.exit(1);
  }
})();