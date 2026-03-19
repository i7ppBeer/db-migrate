-- @skip-syntax-check: true

-- +sanity PreCheck
-- 確認 app_logs 表尚不存在
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs'
-- -sanity PreCheck

-- +migrate Up
-- Create app_logs table for application logging

CREATE TABLE IF NOT EXISTS app_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    level ENUM('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL') NOT NULL DEFAULT 'INFO',
    service_name VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    context JSON,
    trace_id VARCHAR(64),
    span_id VARCHAR(32),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_level (level),
    INDEX idx_service (service_name),
    INDEX idx_trace_id (trace_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 app_logs 表及關鍵索引成功建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_level'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_service'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_trace_id'
-- -sanity PostCheck

-- +migrate Down
DROP TABLE IF EXISTS app_logs;
