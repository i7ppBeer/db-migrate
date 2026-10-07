-- +migrate Up
ALTER TABLE customers ADD COLUMN name VARCHAR(100) NULL;

-- +migrate Down
ALTER TABLE customers DROP COLUMN name;
