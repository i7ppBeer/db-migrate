-- Migration: Re-add FK fk_orders_customer after previous drop (V005)
-- FK Test: V006 — referenced table 'customers' still in allCreatedTables; should pass with no errors

-- +migrate Up

ALTER TABLE orders
    ADD CONSTRAINT fk_orders_customer
        FOREIGN KEY (customer_id)
        REFERENCES customers(id)
        ON DELETE RESTRICT
        ON UPDATE CASCADE;

-- +migrate Down

ALTER TABLE orders
    DROP FOREIGN KEY fk_orders_customer;
