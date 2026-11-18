-- 005: the link page
-- Plaid's ID for the bank, so "this bank is already linked" does not rely on the name.

ALTER TABLE connections ADD COLUMN IF NOT EXISTS institution_id VARCHAR(50);

-- The Sandbox bank linked by scripts/link-sandbox-card.js
UPDATE connections
SET institution_id = 'ins_109508'
WHERE institution_id IS NULL
  AND institution_name = 'First Platypus Bank (Sandbox)';