-- +sanity PreCheck
-- 確認 users 表尚不存在
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users');
-- +migrate Up
-- Create users table for ecommerce database

CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 users 表、email 欄位及唯一索引成功建立
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users';
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users' AND COLUMN_NAME='email';
SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users' AND COLUMN_NAME='password_hash';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='ecommerce' AND TABLE_NAME='users' AND INDEX_NAME='idx_email';
-- +migrate Down
DROP TABLE IF EXISTS users;
