-- Rename to <timestamp>-add-phone-to-users.sql before use.

-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20) NULL;

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
