-- @expect-fail: true
-- Repeatable Migration: INVALID - Not idempotent
-- This should FAIL idempotency check

-- Non-idempotent: Will fail on second run
CREATE USER 'temp_user'@'%' IDENTIFIED BY 'temp_password';

-- No IF NOT EXISTS = not idempotent
GRANT ALL PRIVILEGES ON *.* TO 'temp_user'@'%';

FLUSH PRIVILEGES;
