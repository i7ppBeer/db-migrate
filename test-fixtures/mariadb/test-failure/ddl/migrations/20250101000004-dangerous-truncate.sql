-- FAILURE CASE: Non-idempotent TRUNCATE operation
-- TRUNCATE is dangerous because it cannot be rolled back

-- +migrate Up

-- Dangerous: Destroys all data without possibility of recovery
-- Expected Warning: "Non-reversible operation: TRUNCATE TABLE"
TRUNCATE TABLE products;

INSERT INTO products (sku, name, price) VALUES
    ('NEW-001', 'New Product 1', 99.99),
    ('NEW-002', 'New Product 2', 149.99);

-- +migrate Down

-- PROBLEM: Cannot restore truncated data!
-- The original data is lost forever
DELETE FROM products WHERE sku IN ('NEW-001', 'NEW-002');
