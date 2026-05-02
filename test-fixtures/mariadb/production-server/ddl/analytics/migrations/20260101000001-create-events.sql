-- +sanity PreCheck
-- 確認 events 表尚不存在（避免重複建立）
SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events');
-- +migrate Up
-- Create events table for analytics tracking

CREATE TABLE IF NOT EXISTS events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    event_type VARCHAR(100) NOT NULL,
    user_id INT,
    session_id VARCHAR(128),
    payload JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_event_type (event_type),
    INDEX idx_user_id (user_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 events 表及關鍵索引成功建立
SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_event_type';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_user_id';
SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_created_at';
-- +migrate Down
DROP TABLE IF EXISTS events;
