-- 002_categories.sql
-- Adds the Other category, category rules, merchant rules, and an
-- excluded flag for non-spending transactions (card payments, transfers).

BEGIN;

-- Other: a real budget row that can be renamed and resized but not deleted.
-- Budget starts at 0; users set it during first-use setup.
ALTER TABLE budgets ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
INSERT INTO budgets (category, budget, spent, is_system) VALUES ('other', 0, 0, true);

-- Non-spending transactions stay in the feed but are skipped by budget math.
ALTER TABLE transactions ADD COLUMN excluded BOOLEAN NOT NULL DEFAULT false;

-- Plaid category -> your category. Keyed by Plaid's detailed name
-- (e.g. FOOD_AND_DRINK_GROCERIES) or primary name (e.g. FOOD_AND_DRINK).
-- Lookup tries detailed first, then primary, then falls back to Other.
-- skip = true means "not spending": store it, mark excluded, don't budget it.
CREATE TABLE category_rules (
  id              SERIAL PRIMARY KEY,
  plaid_category  VARCHAR(100) NOT NULL UNIQUE,
  budget_id       INTEGER REFERENCES budgets(id) ON DELETE CASCADE,
  skip            BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (skip = true OR budget_id IS NOT NULL)
);

-- Merchant -> your category, learned from corrections.
-- Matched by Plaid's stable merchant id when present, else by name.
CREATE TABLE merchant_rules (
  id                  SERIAL PRIMARY KEY,
  merchant_entity_id  VARCHAR(100) UNIQUE,
  merchant_name       VARCHAR(200) UNIQUE,
  budget_id           INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (merchant_entity_id IS NOT NULL OR merchant_name IS NOT NULL)
);

-- Starter rules. Looked up by name so this file doesn't depend on id numbers.
INSERT INTO category_rules (plaid_category, budget_id) VALUES
  ('FOOD_AND_DRINK_GROCERIES', (SELECT id FROM budgets WHERE category = 'groceries')),
  ('FOOD_AND_DRINK',           (SELECT id FROM budgets WHERE category = 'dining')),
  ('ENTERTAINMENT',            (SELECT id FROM budgets WHERE category = 'entertainment')),
  ('TRAVEL',                   (SELECT id FROM budgets WHERE category = 'travel')),
  ('TRANSPORTATION',           (SELECT id FROM budgets WHERE category = 'transportation')),
  ('GENERAL_MERCHANDISE',      (SELECT id FROM budgets WHERE category = 'shopping')),
  ('PERSONAL_CARE',            (SELECT id FROM budgets WHERE category = 'shopping')),
  ('HOME_IMPROVEMENT',         (SELECT id FROM budgets WHERE category = 'shopping'));

-- Not spending: card payments, transfers, income.
INSERT INTO category_rules (plaid_category, skip) VALUES
  ('LOAN_PAYMENTS', true),
  ('TRANSFER_IN',   true),
  ('TRANSFER_OUT',  true),
  ('INCOME',        true);

-- Anything else (MEDICAL, RENT_AND_UTILITIES, GENERAL_SERVICES,
-- GOVERNMENT_AND_NON_PROFIT, BANK_FEES) has no rule and lands in Other.

COMMIT;