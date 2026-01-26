-- @description: Dangerous operations example - data cleanup
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: TRUNCATE_TABLE,DELETE_ALL
--
-- This migration demonstrates using @allow-dangerous annotation
-- to permit dangerous operations in a controlled manner.
-- ============================================

-- Create tables if not exist for testing
CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    table_name VARCHAR(100),
    action VARCHAR(50),
    record_id INT,
    user_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    order_date DATE,
    total_amount DECIMAL(10,2)
);

CREATE TABLE IF NOT EXISTS orders_archive (
    id INT PRIMARY KEY,
    user_id INT,
    order_date DATE,
    total_amount DECIMAL(10,2),
    archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Clean up old audit logs (older than 90 days)
-- Note: This is idempotent - safe to run multiple times
DELETE FROM audit_log 
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- Archive old orders to archive table first
INSERT IGNORE INTO orders_archive (id, user_id, order_date, total_amount)
SELECT id, user_id, order_date, total_amount FROM orders 
WHERE order_date < DATE_SUB(NOW(), INTERVAL 365 DAY)
AND id NOT IN (SELECT id FROM orders_archive);

-- Remove archived orders from main table (if any were archived)
DELETE FROM orders 
WHERE order_date < DATE_SUB(NOW(), INTERVAL 365 DAY)
AND id IN (SELECT id FROM orders_archive);
