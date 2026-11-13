-- 003_merchant_ids.sql
-- Stores Plaid's stable merchant id and broad category on each transaction,
-- so merchant rules can be applied to charges already in the table.

BEGIN;

ALTER TABLE transactions ADD COLUMN merchant_entity_id VARCHAR(100);
ALTER TABLE transactions ADD COLUMN provider_category_primary VARCHAR(100);

-- Speeds up "find this merchant's other charges".
CREATE INDEX idx_transactions_merchant_entity ON transactions (merchant_entity_id);

COMMIT;