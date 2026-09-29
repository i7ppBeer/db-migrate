-- Rename to <timestamp>-remove-legacy-orders-table.sql before use.
--
-- Pattern: dropping a table a DIFFERENT, earlier migration created (not this
-- file). `validate` can't see across files, so it can't confirm `legacy_orders`
-- really exists to be dropped — but as long as DOWN recreates exactly what UP
-- dropped, it's auto-allowed with no flag: the migration is self-contained
-- and reversible even though the table's origin isn't in this file. See
-- docs/VALIDATION-RULES-MARIADB.md's ORPHAN_DROP_UP row.
--
-- If DOWN does NOT recreate it (a genuinely permanent removal), this needs
-- `--allow-dangerous` or `-- @allow: ORPHAN_DROP_UP` below instead.

-- +migrate Up
DROP TABLE IF EXISTS legacy_orders;

-- +migrate Down
CREATE TABLE legacy_orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
