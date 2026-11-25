-- 008_savings_targets.sql
-- Savings targets, and a record of every change to them.
-- The amount set aside is never stored on its own: it is the sum of a
-- target's lines, so the history and the balance cannot disagree.

CREATE TABLE IF NOT EXISTS savings_targets (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(20) NOT NULL,
  goal_cents  INTEGER NOT NULL CHECK (goal_cents >= 0),
  -- The category whose screen shows this target. Optional.
  budget_id   INTEGER REFERENCES budgets(id) ON DELETE SET NULL,
  sort_order  INTEGER NOT NULL DEFAULT 1000000,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A removed target is kept, with its lines, so the record stays whole.
  removed_at  TIMESTAMPTZ
);

-- Two targets in use cannot share a name.
CREATE UNIQUE INDEX IF NOT EXISTS savings_targets_name_key
  ON savings_targets (LOWER(name)) WHERE removed_at IS NULL;

-- One line per change. Positive adds, negative takes out.
--   hand    changed by hand, including the amount entered when it was added
--   charge  used for a charge            (a later stage)
--   month   filled when a month closed   (a later stage)
--   move    moved to or from another target
CREATE TABLE IF NOT EXISTS savings_lines (
  id            SERIAL PRIMARY KEY,
  target_id     INTEGER NOT NULL REFERENCES savings_targets(id) ON DELETE CASCADE,
  amount_cents  INTEGER NOT NULL,
  kind          VARCHAR(20) NOT NULL CHECK (kind IN ('hand', 'charge', 'month', 'move')),
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS savings_lines_target_idx ON savings_lines (target_id);