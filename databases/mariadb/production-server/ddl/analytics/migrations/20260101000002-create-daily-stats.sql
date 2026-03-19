-- +sanity PreCheck
-- 確認前置依賴 events 已存在，且 daily_stats 尚未建立
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events';
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats');
-- +migrate Up
-- Create daily_stats aggregation table

CREATE TABLE IF NOT EXISTS daily_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    stat_date DATE NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value DECIMAL(15, 4) NOT NULL DEFAULT 0,
    dimensions JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_date_metric (stat_date, metric_name),
    INDEX idx_stat_date (stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 daily_stats 表及唯一鍵成功建立
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND INDEX_NAME='uk_date_metric';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND INDEX_NAME='idx_stat_date';
-- +migrate Down
DROP TABLE IF EXISTS daily_stats;
