-- @allow: ALTER_TABLE_MODIFY,MODIFY_COLUMN
-- Reviewed by: Data Team — extending VARCHAR(100)→(200) is safe (no truncation risk, data widening only)
-- +migrate Up
-- Extend event_type column from VARCHAR(100) to VARCHAR(200)
-- to support longer namespaced event names (e.g., "checkout.payment.credit_card.failed")
-- Also extend metric_name in daily_stats for the same reason

ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(200) NOT NULL;

ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(200) NOT NULL;

-- +migrate Down
ALTER TABLE daily_stats
    MODIFY COLUMN metric_name VARCHAR(100) NOT NULL;

ALTER TABLE events
    MODIFY COLUMN event_type VARCHAR(100) NOT NULL;
