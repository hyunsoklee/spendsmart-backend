-- 001_transactions.sql
-- Adds users, bank connections, card accounts, and transactions.
-- Wrapped in BEGIN/COMMIT: if any line fails, nothing is applied.

BEGIN;

-- Who's in the household. No login yet; real auth comes in the security phase.
CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(50) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO users (name) VALUES ('Hyun'), ('Hwayeon');

-- One row per linked bank login (a Plaid "Item").
CREATE TABLE connections (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL REFERENCES users(id),   -- who linked it
  provider          VARCHAR(20) NOT NULL CHECK (provider IN ('plaid', 'teller', 'simplefin')),
  provider_item_id  VARCHAR(100),
  institution_name  VARCHAR(100),
  access_token      TEXT NOT NULL,   -- plain text OK for Sandbox only; encrypted before real data
  sync_cursor       TEXT,
  status            VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'needs_reauth', 'disconnected')),
  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_item_id)
);

-- One row per card account.
CREATE TABLE accounts (
  id                     SERIAL PRIMARY KEY,
  connection_id          INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_account_id    VARCHAR(100) NOT NULL,
  name                   VARCHAR(100) NOT NULL,
  mask                   VARCHAR(4),
  default_split_user_id  INTEGER REFERENCES users(id),   -- NULL = Shared
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, provider_account_id)
);

-- Every charge and refund. This is the table the app reads.
CREATE TABLE transactions (
  id                 SERIAL PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider           VARCHAR(20) NOT NULL,
  provider_txn_id    VARCHAR(100) NOT NULL,
  amount_cents       INTEGER NOT NULL,          -- positive = spending, negative = refund
  currency           CHAR(3) NOT NULL DEFAULT 'USD',
  date               DATE NOT NULL,             -- posted date
  authorized_date    DATE,                      -- swipe date
  merchant_name      VARCHAR(200),
  raw_description    TEXT,
  provider_category  VARCHAR(100),
  account_owner_raw  VARCHAR(100),              -- cardholder text from the bank, if any
  category_id        INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  category_source    VARCHAR(10) NOT NULL DEFAULT 'auto'
                     CHECK (category_source IN ('auto', 'user')),
  pending            BOOLEAN NOT NULL DEFAULT false,
  pending_of_id      INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  split_user_id      INTEGER REFERENCES users(id),  -- NULL = Shared
  removed_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_txn_id)
);

-- Speeds up "show me this category's charges, newest first".
CREATE INDEX idx_transactions_category_date ON transactions (category_id, date DESC);
CREATE INDEX idx_transactions_account_date  ON transactions (account_id, date DESC);

COMMIT;