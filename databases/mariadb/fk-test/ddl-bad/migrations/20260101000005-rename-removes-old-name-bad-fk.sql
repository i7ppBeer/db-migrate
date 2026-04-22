-- Migration: BAD EXAMPLE — RENAME removes an old table name; FK in the same file still
--            references the old name as if it still exists.
-- FK Test (cross-file): FK_UNRESOLVED_REFERENCE expected
--
-- Failure mode: The UP section renames 'orders' → 'orders_legacy' and then immediately
-- tries to create 'invoices' with a FK back to the now-missing 'orders'.
-- Because RENAME treats the old name as "dropped", 'orders' is no longer available in
-- this file's reference set — even for FKs declared later in the same file.
-- This tests that the RENAME tracking correctly removes the old name before the FK
-- resolution check runs.

-- +migrate Up

RENAME TABLE orders TO orders_legacy;   -- 'orders' is now gone; 'orders_legacy' takes its place

CREATE TABLE IF NOT EXISTS invoices (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    order_id    BIGINT UNSIGNED NOT NULL COMMENT 'Intended to reference orders, but orders was renamed',
    amount      DECIMAL(10,2)   NOT NULL,
    issued_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    KEY idx_invoices_order (order_id),

    CONSTRAINT fk_invoices_order
        FOREIGN KEY (order_id)
        REFERENCES orders(id)         -- 'orders' no longer exists — it was renamed above!
        ON DELETE RESTRICT
        ON UPDATE CASCADE

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS invoices;
RENAME TABLE orders_legacy TO orders;
