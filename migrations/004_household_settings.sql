-- 004_household_settings.sql
-- Household-level settings: planned savings and whether setup is done.
-- One row for now (the app has one household); the CHECK keeps it to one.
-- Take-home income and spending not on cards are deliberately NOT stored here.

BEGIN;

CREATE TABLE household_settings (
  id                  INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  planned_savings     INTEGER NOT NULL DEFAULT 0 CHECK (planned_savings >= 0), -- whole dollars per month, like budgets
  setup_completed_at  TIMESTAMPTZ,                                            -- empty until setup is finished
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO household_settings (id) VALUES (1);

COMMIT;