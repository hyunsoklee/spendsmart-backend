// plaidClient.js
// One shared connection to Plaid. Reads keys from .env.

const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const env = process.env.PLAID_ENV;

if (!PlaidEnvironments[env]) {
  throw new Error(`PLAID_ENV must be "sandbox" or "production" — got "${env}"`);
}

const configuration = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

module.exports = new PlaidApi(configuration);