-- Migration: Create products table
-- FK Test: V002 — no FK here either, parent table for order_items

-- +migrate Up

CREATE TABLE IF NOT EXISTS products (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    sku         VARCHAR(100)    NOT NULL,
    name        VARCHAR(255)    NOT NULL,
    price       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY idx_products_sku (sku)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS products;
