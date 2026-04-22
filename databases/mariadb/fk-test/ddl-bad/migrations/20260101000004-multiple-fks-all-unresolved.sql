-- Migration: BAD EXAMPLE — CREATE TABLE with multiple FKs, all pointing to non-existent tables
-- FK Test (cross-file): two FK_UNRESOLVED_REFERENCE errors expected
--
-- Failure mode: A single file creates a new table ('shipments') that carries two FK
-- constraints, both referencing tables that have never been created anywhere in the
-- migration history ('carriers' and 'warehouses').
-- This validates that the validator reports EACH unresolved FK independently, not just
-- the first one.

-- +migrate Up

CREATE TABLE IF NOT EXISTS shipments (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    carrier_id      BIGINT UNSIGNED NOT NULL,
    warehouse_id    BIGINT UNSIGNED NOT NULL,
    tracking_no     VARCHAR(100)    NOT NULL DEFAULT '',
    shipped_at      TIMESTAMP       NULL,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    KEY idx_shipments_carrier   (carrier_id),
    KEY idx_shipments_warehouse (warehouse_id),

    CONSTRAINT fk_shipments_carrier
        FOREIGN KEY (carrier_id)
        REFERENCES carriers(id)     -- 'carriers' was never created!
        ON DELETE RESTRICT
        ON UPDATE CASCADE,

    CONSTRAINT fk_shipments_warehouse
        FOREIGN KEY (warehouse_id)
        REFERENCES warehouses(id)   -- 'warehouses' was never created either!
        ON DELETE RESTRICT
        ON UPDATE CASCADE

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +migrate Down

DROP TABLE IF EXISTS shipments;
