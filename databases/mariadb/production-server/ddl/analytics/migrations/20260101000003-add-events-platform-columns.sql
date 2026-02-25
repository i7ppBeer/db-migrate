-- +migrate Up
-- Add platform and country_code columns to events table
-- platform: device/OS platform (web, ios, android, desktop)
-- country_code: ISO 3166-1 alpha-2 (e.g., TW, US, JP)

ALTER TABLE events
    ADD COLUMN platform VARCHAR(50) DEFAULT NULL AFTER user_agent,
    ADD COLUMN country_code CHAR(2) DEFAULT NULL AFTER platform;

CREATE INDEX idx_events_platform ON events (platform);
CREATE INDEX idx_events_country ON events (country_code);

-- +migrate Down
DROP INDEX idx_events_country ON events;
DROP INDEX idx_events_platform ON events;

ALTER TABLE events
    DROP COLUMN country_code,
    DROP COLUMN platform;
