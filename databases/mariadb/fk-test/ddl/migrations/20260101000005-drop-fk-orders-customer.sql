-- @allow: DROP_FOREIGN_KEY
-- Migration: Drop FK fk_orders_customer to test drop → re-add scenario
-- FK Test: V005 — DROP FOREIGN KEY with @allow annotation; orders table keeps existing data

-- +migrate Up

ALTER TABLE orders
    DROP FOREIGN KEY fk_orders_customer;

-- +migrate Down

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE;
