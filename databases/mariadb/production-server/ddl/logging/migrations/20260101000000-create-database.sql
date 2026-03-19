-- +sanity PreCheck
-- 確認 logging 資料庫尚不存在
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='logging'
-- END_CHECK

-- +migrate Up
-- ============================================================
-- Create logging database
-- ============================================================
-- This migration creates the logging database for application logs
-- and audit trails. This is the first migration and must be executed
-- before any other DDL migrations.
--
-- The database will be auto-created by the adapter if it doesn't exist,
-- but this migration provides an explicit record in version history.
-- ============================================================

CREATE DATABASE IF NOT EXISTS logging
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE logging;

-- +sanity PostCheck
-- 確認 logging 資料庫成功建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='logging'
-- END_CHECK

-- +migrate Down
-- ============================================================
-- Drop logging database
-- ============================================================
-- ⚠️ WARNING: This operation is FORBIDDEN by default!
-- It will be blocked by validation rules unless you use --allow-forbidden
-- This is a safety measure to prevent accidental data loss.
-- 
-- To execute this rollback, you must:
-- 1. Get approval from team lead
-- 2. Ensure backup exists
-- 3. Run: node src/cli.js down -c config.js --allow-forbidden
-- ============================================================
-- @allow-forbidden: true

DROP DATABASE IF EXISTS logging;
