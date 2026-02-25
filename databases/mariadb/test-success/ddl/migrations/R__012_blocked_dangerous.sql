-- @description: Maintenance - index rebuild and scratch data cleanup
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: DROP_INDEX,TRUNCATE_TABLE
--
-- Demonstrates @allow-dangerous annotation for controlled maintenance ops.
-- Uses a dedicated scratch table that this migration manages itself.
-- ============================================

CREATE TABLE IF NOT EXISTS _maintenance_scratch (
    id   INT AUTO_INCREMENT PRIMARY KEY,
    data VARCHAR(100),
    tag  VARCHAR(50),
    INDEX idx_maint_scratch_tag (tag)
);

-- Re-create index to compact it (allowed via @allow-dangerous)
DROP INDEX idx_maint_scratch_tag ON _maintenance_scratch;
CREATE INDEX idx_maint_scratch_tag ON _maintenance_scratch (tag);

-- Truncate scratch data (allowed via @allow-dangerous)
TRUNCATE TABLE _maintenance_scratch;
