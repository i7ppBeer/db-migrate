-- Migration: BAD EXAMPLE — orders references customers which hasn't been created yet
-- FK Test (cross-file): FK_UNRESOLVED_REFERENCE expected

-- +migrate Up

CREATE TABLE IF NOT EXISTS orders (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    total       DECIMAL(10,2)   NOT NULL DEFAULT 0.00,
    created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)   -- customers not yet created in any prior migration!
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS orders;
