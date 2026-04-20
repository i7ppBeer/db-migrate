-- Migration: Add shipping_address table with self-referential FK example
-- FK Test: V004 — self-ref FK (parent_id → itself) + FK to customers

-- +migrate Up

CREATE TABLE IF NOT EXISTS addresses (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    parent_id   BIGINT UNSIGNED NULL COMMENT 'For grouped/sub-addresses (self-ref)',
    line1       VARCHAR(255)    NOT NULL,
    city        VARCHAR(100)    NOT NULL,
    country     VARCHAR(2)      NOT NULL DEFAULT 'TW',
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    KEY idx_addresses_customer (customer_id),
    CONSTRAINT fk_addresses_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE,
    CONSTRAINT fk_addresses_parent
        FOREIGN KEY (parent_id)
        REFERENCES addresses(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS addresses;
