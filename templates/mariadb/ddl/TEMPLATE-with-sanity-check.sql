-- Rename to <timestamp>-add-phone-with-sanity.sql before use.
-- Run with: node src/cli.js up --sanity-check -c <ddl-config>
-- (plain `up`/`sync` without --sanity-check just skips these blocks and
-- runs the Up SQL normally — PreCheck/PostCheck are opt-in, per-command.)
--
-- EXPECT_NO_ROWS / EXPECT_ROWS are checked by ROW COUNT, not by the value of
-- a returned column — `SELECT COUNT(*) AS cnt ...` always returns exactly
-- one row (even when cnt is 0) and would silently pass either check. Use a
-- query shaped to return zero rows when absent, e.g. `SELECT 1 FROM ... LIMIT 1`.

-- +migrate Up

-- +sanity PreCheck
-- Fails fast, before touching anything, if the precondition doesn't hold —
-- cheaper than discovering it mid-ALTER.
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PreCheck

ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL;

-- +sanity PostCheck
-- If this fails, autoRollback (default: on) automatically runs the Down
-- section below.
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
