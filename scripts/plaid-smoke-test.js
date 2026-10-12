// scripts/plaid-smoke-test.js
// Checks that the Plaid Sandbox keys work. Saves nothing.
// Run from the backend folder: node scripts/plaid-smoke-test.js

require('dotenv').config();
const plaid = require('../plaidClient');

(async () => {
  try {
    // 1. Simulate a user logging into a fake bank
    const { data: created } = await plaid.sandboxPublicTokenCreate({
      institution_id: 'ins_109508', // First Platypus Bank (Sandbox)
      initial_products: ['transactions'],
    });

    // 2. Exchange the temporary token for a lasting access token
    const { data: exchanged } = await plaid.itemPublicTokenExchange({
      public_token: created.public_token,
    });

    // 3. List the accounts on that fake login
    const { data } = await plaid.accountsGet({
      access_token: exchanged.access_token,
    });

    console.log('✅ Plaid Sandbox works. Accounts found:');
    data.accounts.forEach((a) => {
      console.log(`   - ${a.name} (${a.subtype}) ••••${a.mask}`);
    });
  } catch (err) {
    console.error('❌ Plaid error:', err.response?.data || err.message);
    process.exit(1);
  }
})();