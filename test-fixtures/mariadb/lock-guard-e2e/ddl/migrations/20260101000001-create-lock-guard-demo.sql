-- Migration: baseline table for the lock-guard e2e scenarios.
-- No contention expected here — this just needs to exist before the
-- ALTER in the next migration can be used to reproduce MDL queueing.

-- +migrate Up

CREATE TABLE IF NOT EXISTS lock_guard_demo (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO lock_guard_demo (status) VALUES ('active'), ('active'), ('active');

-- +migrate Down

DROP TABLE IF EXISTS lock_guard_demo;
