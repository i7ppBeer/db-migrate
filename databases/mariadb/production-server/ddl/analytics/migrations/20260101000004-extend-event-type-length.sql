-- @allow: ALTER_TABLE_MODIFY,MODIFY_COLUMN
-- Reviewed by: Data Team — extending VARCHAR(100)→(200) is safe (no truncation risk, data widening only)

-- +sanity PreCheck
-- 確認欄位目前為 VARCHAR(100)，防止重複執行
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='event_type' AND CHARACTER_MAXIMUM_LENGTH=100
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND COLUMN_NAME='metric_name' AND CHARACTER_MAXIMUM_LENGTH=100
-- -sanity PreCheck

-- +migrate Up
-- Extend event_type column from VARCHAR(100) to VARCHAR(200)
-- to support longer namespaced event names (e.g., "checkout.payment.credit_card.failed")
-- Also extend metric_name in daily_stats for the same reason

ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(200) NOT NULL;

ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(200) NOT NULL;

-- +sanity PostCheck
-- 確認兩個欄位已成功擴展為 VARCHAR(200)
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='events' AND COLUMN_NAME='event_type' AND CHARACTER_MAXIMUM_LENGTH=200
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='analytics' AND TABLE_NAME='daily_stats' AND COLUMN_NAME='metric_name' AND CHARACTER_MAXIMUM_LENGTH=200
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(100) NOT NULL;

ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(100) NOT NULL;
