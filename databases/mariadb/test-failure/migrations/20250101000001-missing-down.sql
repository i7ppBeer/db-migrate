-- FAILURE CASE: Missing Down section
-- This migration will fail validation because there's no rollback

-- +migrate Up

CREATE TABLE test_no_rollback (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_test_name ON test_no_rollback(name);

-- BUG: No +migrate Down section!
-- Expected Error: "Missing +migrate Down section"
