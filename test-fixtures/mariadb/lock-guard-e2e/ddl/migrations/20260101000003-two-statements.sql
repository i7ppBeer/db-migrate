-- Migration: two statements, the second on the contended table — used by
-- test/integration.test.js to prove Lock Guard retries only the statement
-- that hit the lock timeout. The first statement is a plain CREATE TABLE
-- (no IF NOT EXISTS) on purpose: running it a second time fails, which is
-- exactly what re-running the whole migration on retry used to do.

-- +migrate Up

CREATE TABLE lock_guard_side (id INT PRIMARY KEY);
ALTER TABLE lock_guard_demo ADD COLUMN retried_col INT NULL;

-- +migrate Down

ALTER TABLE lock_guard_demo DROP COLUMN retried_col;
DROP TABLE lock_guard_side;
