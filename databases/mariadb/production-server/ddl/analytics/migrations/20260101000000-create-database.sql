-- +migrate Up
-- ============================================================
-- Create analytics database
-- ============================================================
-- This migration creates the analytics database for events and
-- statistics tracking. This is the first migration and must be
-- executed before any other DDL migrations.
--
-- The database will be auto-created by the adapter if it doesn't exist,
-- but this migration provides an explicit record in version history.
-- ============================================================

CREATE DATABASE IF NOT EXISTS analytics
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- +migrate Down
-- ============================================================
-- Drop analytics database
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

DROP DATABASE IF EXISTS analytics;
