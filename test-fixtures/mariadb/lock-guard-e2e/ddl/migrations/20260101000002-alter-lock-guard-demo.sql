-- Migration: the ALTER used to reproduce MDL queueing against a
-- concurrent long-running transaction on lock_guard_demo (see
-- test/integration.test.js). Left pending on purpose across scenarios —
-- the e2e test drives when this actually gets applied.

-- +migrate Up

ALTER TABLE lock_guard_demo ADD COLUMN note VARCHAR(255) NULL;

-- +migrate Down

ALTER TABLE lock_guard_demo DROP COLUMN note;
