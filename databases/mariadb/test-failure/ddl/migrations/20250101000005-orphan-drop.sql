-- FAILURE CASE: Orphan DROP in down() section
-- Drops a table that wasn't created in up()

-- +migrate Up

CREATE TABLE new_feature_table (
    id INT PRIMARY KEY AUTO_INCREMENT,
    feature_name VARCHAR(100) NOT NULL
);

-- +migrate Down

-- BUG: Dropping wrong table!
-- This table was not created by this migration
-- Expected Error: "Orphan drop: DROP TABLE for 'legacy_table' not created in up()"
DROP TABLE IF EXISTS legacy_table;

-- Correct rollback would be:
-- DROP TABLE IF EXISTS new_feature_table;
