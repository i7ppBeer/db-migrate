-- +sanity PreCheck
-- 確認前置依賴 app_logs 已存在，且 audit_trail 尚未建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='app_logs'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='audit_trail'
-- -sanity PreCheck

-- +migrate Up
-- Create audit_trail table for security auditing

CREATE TABLE IF NOT EXISTS audit_trail (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(50) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id VARCHAR(100),
    actor_id INT,
    actor_ip VARCHAR(45),
    old_values JSON,
    new_values JSON,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_action (action),
    INDEX idx_entity (entity_type, entity_id),
    INDEX idx_actor (actor_id),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- +sanity PostCheck
-- 確認 audit_trail 表及關鍵索引成功建立
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='audit_trail'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='audit_trail' AND COLUMN_NAME='actor_id'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='audit_trail' AND INDEX_NAME='idx_entity'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='logging' AND TABLE_NAME='audit_trail' AND INDEX_NAME='idx_actor'
-- -sanity PostCheck

-- +migrate Down
DROP TABLE IF EXISTS audit_trail;
