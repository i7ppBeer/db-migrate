-- FAILURE CASE: DCL operations (User/Grant management)
-- These should NOT be in regular migrations

-- +migrate Up

CREATE TABLE audit_log (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    action VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- PROBLEM: User management should be separate!
-- Expected Error: "DCL operation detected: CREATE USER"
CREATE USER 'app_user'@'%' IDENTIFIED BY 'insecure_password_123';
GRANT SELECT, INSERT, UPDATE ON myapp.* TO 'app_user'@'%';

-- +migrate Down

DROP USER IF EXISTS 'app_user'@'%';
DROP TABLE IF EXISTS audit_log;
