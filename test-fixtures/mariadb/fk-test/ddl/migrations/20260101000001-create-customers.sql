-- Migration: Create customers table
-- FK Test: V001 — no FK here, must be created first so V002/V003 can reference it

-- +migrate Up

CREATE TABLE IF NOT EXISTS customers (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    email       VARCHAR(255)    NOT NULL,
    name        VARCHAR(100)    NOT NULL,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_customers_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS customers;
