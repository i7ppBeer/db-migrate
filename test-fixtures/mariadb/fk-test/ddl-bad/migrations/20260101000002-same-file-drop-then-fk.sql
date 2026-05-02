-- Migration: BAD EXAMPLE — same-file DROP then FK to dropped table
-- FK Test (single-file): FK_REFERENCES_DROPPED_TABLE expected

-- +migrate Up

DROP TABLE IF EXISTS products;   -- drops products in this UP section

CREATE TABLE IF NOT EXISTS order_items (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    product_id  BIGINT UNSIGNED NOT NULL,
    qty         INT UNSIGNED    NOT NULL DEFAULT 1,

    CONSTRAINT fk_items_product
        FOREIGN KEY (product_id)
        REFERENCES products(id)  -- products was just dropped above!
        ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS order_items;
