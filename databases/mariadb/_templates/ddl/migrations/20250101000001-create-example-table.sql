-- 20250101000001-create-example-table.sql
-- Migration: Create example table (DDL 範本)
--
-- 說明:
--   - 檔名格式: YYYYMMDDHHMMSS-description.sql
--   - 使用 +migrate Up / +migrate Down 區分升級和降級
--   - 使用 +sanity PreCheck / PostCheck 進行驗證
--
-- 執行方式:
--   docker compose run --rm migrate up -c /app/databases/mariadb/<project>/ddl/config.js
--   docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/<project>/ddl/config.js

-- +sanity PreCheck
-- 驗證: 資料表尚未存在
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='example'
-- END_CHECK

-- +migrate Up
CREATE TABLE IF NOT EXISTS example (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    -- 索引
    KEY idx_example_status (status),
    KEY idx_example_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 驗證: 資料表和索引已建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='example'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='example' AND column_name='id'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='example' AND index_name='idx_example_status'
-- END_CHECK

-- +migrate Down
DROP TABLE IF EXISTS example;
