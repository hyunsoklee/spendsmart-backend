// sync/plaidAdapter.js
// The only file that knows Plaid's field names.
// Returns accounts and transaction changes in a provider-neutral shape.

const plaid = require('../plaidClient');

const PROVIDER = 'plaid';

// Plaid amounts: positive = money leaving the account (a charge),
// negative = money coming in (a payment or refund). Same as our convention.
function toCents(amount) {
  return Math.round(amount * 100);
}

// Plaid transaction -> our neutral shape
function normalizeTransaction(t) {
  const pfc = t.personal_finance_category || {};
  return {
    providerTxnId: t.transaction_id,
    providerAccountId: t.account_id,
    amountCents: toCents(t.amount),
    currency: t.iso_currency_code || 'USD',
    date: t.date,
    authorizedDate: t.authorized_date || null,
    merchantName: t.merchant_name || null,
    rawDescription: t.name || null,
    merchantEntityId: t.merchant_entity_id || null,
    categoryPrimary: pfc.primary || null,
    categoryDetailed: pfc.detailed || null,
    pending: Boolean(t.pending),
    pendingOfProviderTxnId: t.pending_transaction_id || null,
    accountOwnerRaw: t.account_owner || null,
  };
}

// Credit-card accounts only. Checking, savings, loans never reach the app.
async function listCardAccounts(accessToken) {
  const { data } = await plaid.accountsGet({ access_token: accessToken });
  return data.accounts
    .filter((a) => a.type === 'credit' && a.subtype === 'credit card')
    .map((a) => ({
      providerAccountId: a.account_id,
      name: a.official_name || a.name,
      mask: a.mask || null,
    }));
}

// Everything that changed since `cursor` (null = full history).
// Plaid pages the results; we loop until has_more is false.
async function fetchChanges(accessToken, cursor) {
  const added = [];
  const modified = [];
  const removed = [];
  let nextCursor = cursor || undefined;
  let hasMore = true;

  while (hasMore) {
    const { data } = await plaid.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor,
      count: 500,
    });

    added.push(...data.added.map(normalizeTransaction));
    modified.push(...data.modified.map(normalizeTransaction));
    removed.push(...data.removed.map((r) => r.transaction_id));

    nextCursor = data.next_cursor;
    hasMore = data.has_more;
  }

  return { added, modified, removed, nextCursor };
}

// How far back to fetch charges when a bank is first linked: Plaid's maximum.
// Plaid does not allow this to be changed after a connection is created.
const HISTORY_DAYS = 730;

// A short-lived token that lets the browser open Plaid's sign-in window.
async function createLinkToken(userId) {
  const { data } = await plaid.linkTokenCreate({
    user: { client_user_id: `user-${userId}` },
    client_name: 'Sprinkles',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
    transactions: { days_requested: HISTORY_DAYS },
    // Cards only: checking, savings and loans are never offered.
    account_filters: { credit: { account_subtypes: ['credit card'] } },
  });
  return data.link_token;
}

// Trades the one-time token from the sign-in window for the lasting one.
async function exchangePublicToken(publicToken) {
  const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

module.exports = {
  PROVIDER,
  listCardAccounts,
  fetchChanges,
  createLinkToken,
  exchangePublicToken,
};