-- Migration: Seed initial users
-- Type: DML (Data Manipulation Language)
-- Uses INSERT ... ON DUPLICATE KEY UPDATE for idempotency

-- +migrate Up

INSERT INTO users (id, email, name, password_hash, status, created_at) 
VALUES 
    (1, 'admin@example.com', 'System Admin', '$2b$10$placeholder_hash_admin', 'active', '2025-01-01 00:00:00'),
    (2, 'demo@example.com', 'Demo User', '$2b$10$placeholder_hash_demo', 'active', '2025-01-01 00:00:00'),
    (3, 'test@example.com', 'Test User', '$2b$10$placeholder_hash_test', 'pending', '2025-01-01 00:00:00')
ON DUPLICATE KEY UPDATE
    name = VALUES(name),
    updated_at = CURRENT_TIMESTAMP;

-- +migrate Down

DELETE FROM users WHERE id IN (1, 2, 3);
