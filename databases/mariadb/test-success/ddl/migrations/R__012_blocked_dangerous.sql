-- @description: Test dangerous operations without allow annotation
-- @type: maintenance
--
-- This file should be BLOCKED by validation because it contains
-- dangerous operations without the @allow-dangerous annotation.
-- ============================================

-- This DROP INDEX should be blocked
DROP INDEX idx_some_index ON some_table;

-- This TRUNCATE should also be blocked
TRUNCATE TABLE temp_data;
