-- Migration: BAD EXAMPLE — ALTER TABLE adds FK that references a never-created table
-- FK Test (cross-file): FK_UNRESOLVED_REFERENCE expected
--
-- Failure mode: A file that contains only ALTER TABLE (no CREATE TABLE) adds a FK
-- to a table ('departments') that was never created in any migration file.
-- This tests that the validator catches FK references in ALTER-only migration files,
-- not just in CREATE TABLE definitions.

-- +migrate Up

ALTER TABLE orders ADD COLUMN dept_id BIGINT UNSIGNED NULL;

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_dept
        FOREIGN KEY (dept_id)
        REFERENCES departments(id)   -- 'departments' was never created!
        ON DELETE SET NULL
        ON UPDATE CASCADE;

-- +migrate Down

ALTER TABLE orders DROP FOREIGN KEY fk_orders_dept;
ALTER TABLE orders DROP COLUMN dept_id;
