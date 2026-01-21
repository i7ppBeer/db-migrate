-- Migration: Add profile columns to users table
-- Type: Schema Migration (ALTER TABLE)
-- Shows safe schema evolution pattern

-- +migrate Up

ALTER TABLE users
    ADD COLUMN avatar_url VARCHAR(500) AFTER password_hash,
    ADD COLUMN bio TEXT AFTER avatar_url,
    ADD COLUMN website VARCHAR(255) AFTER bio,
    ADD COLUMN location VARCHAR(100) AFTER website,
    ADD COLUMN timezone VARCHAR(50) DEFAULT 'UTC' AFTER location,
    ADD COLUMN locale VARCHAR(10) DEFAULT 'en' AFTER timezone;

-- Create user preferences table for extensibility
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    theme ENUM('light', 'dark', 'system') NOT NULL DEFAULT 'system',
    email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
    sms_notifications BOOLEAN NOT NULL DEFAULT FALSE,
    marketing_emails BOOLEAN NOT NULL DEFAULT FALSE,
    settings JSON,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default preferences for existing users
INSERT INTO user_preferences (user_id, theme)
SELECT id, 'system' FROM users
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP;

-- +migrate Down

DROP TABLE IF EXISTS user_preferences;

ALTER TABLE users
    DROP COLUMN avatar_url,
    DROP COLUMN bio,
    DROP COLUMN website,
    DROP COLUMN location,
    DROP COLUMN timezone,
    DROP COLUMN locale;
