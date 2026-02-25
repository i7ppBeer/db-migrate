-- FAILURE CASE: Dangerous DROP DATABASE operation
-- This will fail validation because it destroys everything

-- +migrate Up

CREATE TABLE IF NOT EXISTS temp_table (
    id INT PRIMARY KEY
);

-- +migrate Down

-- DANGER: This will destroy the entire database!
-- Expected Error: "Dangerous operation detected: DROP DATABASE"
DROP DATABASE IF EXISTS myapp;
