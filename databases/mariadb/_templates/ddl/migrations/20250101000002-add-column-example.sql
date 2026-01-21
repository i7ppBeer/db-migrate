-- 20250101000002-add-column-example.sql
-- Migration: Add columns to example table (新增欄位範本)
--
-- 說明:
--   - 新增欄位時，建議使用 PreCheck 確認欄位不存在
--   - PostCheck 驗證欄位已正確建立
--   - Down 中的 DROP 順序要反過來 (先 index 後 column)
--
-- 執行方式:
--   docker compose run --rm migrate up --sanity-check -c /app/databases/mariadb/<project>/ddl/config.js

-- +sanity PreCheck
-- 驗證: example 資料表存在且 email 欄位尚未存在
-- EXPECT_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='example'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='example' AND column_name='email'
-- END_CHECK

-- +migrate Up
-- 新增 email 欄位
ALTER TABLE example ADD COLUMN email VARCHAR(255) DEFAULT NULL COMMENT 'Email address';
ALTER TABLE example ADD COLUMN email_verified BOOLEAN DEFAULT FALSE COMMENT 'Email verification status';
ALTER TABLE example ADD COLUMN email_verified_at TIMESTAMP NULL COMMENT 'Email verification timestamp';

-- 建立索引
CREATE UNIQUE INDEX idx_example_email ON example(email);

-- +sanity PostCheck
-- 驗證: 欄位和索引已建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='example' AND column_name='email'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='example' AND column_name='email_verified'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='example' AND column_name='email_verified_at'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='example' AND index_name='idx_example_email'
-- END_CHECK

-- +migrate Down
-- 移除索引和欄位 (注意順序: 先 index 後 column)
DROP INDEX idx_example_email ON example;
ALTER TABLE example DROP COLUMN email_verified_at;
ALTER TABLE example DROP COLUMN email_verified;
ALTER TABLE example DROP COLUMN email;
