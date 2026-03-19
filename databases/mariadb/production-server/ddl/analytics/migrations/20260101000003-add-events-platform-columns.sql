-- +sanity PreCheck
-- 確認 events 表已存在，且 platform 欄位尚未加入（冪等保護）
-- EXPECT_ROWS: SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='platform'
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='country_code'
-- END_CHECK

-- +migrate Up
-- Add platform and country_code columns to events table
-- platform: device/OS platform (web, ios, android, desktop)
-- country_code: ISO 3166-1 alpha-2 (e.g., TW, US, JP)

ALTER TABLE events
    ADD COLUMN platform VARCHAR(50) DEFAULT NULL AFTER user_agent,
    ADD COLUMN country_code CHAR(2) DEFAULT NULL AFTER platform;

CREATE INDEX idx_events_platform ON events (platform);
CREATE INDEX idx_events_country ON events (country_code);

-- +sanity PostCheck
-- 確認 platform、country_code 欄位及對應索引成功加入
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='platform'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='country_code'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_events_platform'
-- EXPECT_ROWS: SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND INDEX_NAME='idx_events_country'
-- END_CHECK

-- +migrate Down
DROP INDEX idx_events_country ON events;
DROP INDEX idx_events_platform ON events;

ALTER TABLE events
    DROP COLUMN country_code,
    DROP COLUMN platform;
