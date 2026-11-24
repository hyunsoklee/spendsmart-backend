-- 007: the household's own order for categories.
-- A new category gets a large number, so it appears last (just above Other)
-- until someone arranges the list.

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 1000000;

-- Existing categories keep the order they have today.
UPDATE budgets SET sort_order = id WHERE sort_order = 1000000;