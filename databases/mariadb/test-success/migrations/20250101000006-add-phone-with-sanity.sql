-- 20250101000006-add-phone-column-with-sanity.sql
-- Migration: Add phone column to users table (with Sanity Check)
-- This migration demonstrates SQL Sanity Check feature

-- +sanity PreCheck
-- Verify users table exists and phone column does not exist yet
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- END_CHECK

-- +migrate Up
-- Add phone column with default value
ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL COMMENT 'User phone number';
ALTER TABLE users ADD COLUMN phone_verified BOOLEAN DEFAULT FALSE COMMENT 'Phone verification status';
ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMP NULL COMMENT 'Phone verification timestamp';

-- Create index for phone lookups
CREATE INDEX idx_users_phone ON users(phone);

-- +sanity PostCheck
-- Verify columns and index were created successfully
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='phone_verified'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='users' AND index_name='idx_users_phone'
-- END_CHECK

-- +migrate Down
-- Remove phone related columns and index
DROP INDEX idx_users_phone ON users;
ALTER TABLE users DROP COLUMN phone_verified_at;
ALTER TABLE users DROP COLUMN phone_verified;
ALTER TABLE users DROP COLUMN phone;
