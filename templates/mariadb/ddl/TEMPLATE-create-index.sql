-- Rename to <timestamp>-add-orders-customer-created-index.sql before use.

-- +migrate Up
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at);

-- +migrate Down
DROP INDEX idx_orders_customer_created ON orders;
