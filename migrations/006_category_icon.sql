-- 006: each category gets an icon of its own, separate from its name.
-- Until now the app chose the icon from the name, so a renamed or new
-- category would have shown the wrong one.

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS icon VARCHAR(40);

-- Existing categories keep the icon they have today.
UPDATE budgets SET icon = LOWER(category) WHERE icon IS NULL;

-- From now on every category must have one.
ALTER TABLE budgets ALTER COLUMN icon SET DEFAULT 'other';
ALTER TABLE budgets ALTER COLUMN icon SET NOT NULL;