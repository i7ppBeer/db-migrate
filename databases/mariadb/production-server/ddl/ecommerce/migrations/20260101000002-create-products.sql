-- +sanity PreCheck
-- 確認前置依賴 users 表已存在，且 products 表尚未建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products'
-- END_CHECK

-- +migrate Up
-- Create products table for ecommerce database

CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    sku VARCHAR(50) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    stock_quantity INT DEFAULT 0,
    category_id INT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sku (sku),
    INDEX idx_category (category_id),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 products 表、sku 欄位及關鍵索引成功建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products' AND COLUMN_NAME='sku'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products' AND COLUMN_NAME='price'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products' AND INDEX_NAME='idx_sku'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='products' AND INDEX_NAME='idx_category'
-- END_CHECK

-- +migrate Down
DROP TABLE IF EXISTS products;
