-- @skip-syntax-check: true

-- +sanity PreCheck
-- 確認 app_logs 表尚不存在
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs');
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
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_level';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_service';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs' AND INDEX_NAME='idx_trace_id';
-- +migrate Down
DROP TABLE IF EXISTS app_logs;
