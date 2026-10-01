-- @expect-sanity: rollback
-- The Post-Check expects order_no to be VARCHAR(32), but Up creates it as
-- VARCHAR(16) — the kind of mistake a sanity check exists to catch. With
-- --sanity-check the migration must be rolled back (Down runs) and not
-- recorded as applied.

-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='sanity_orders'
-- END_CHECK

-- +migrate Up
CREATE TABLE sanity_orders (
  id INT PRIMARY KEY,
  order_no VARCHAR(16) NOT NULL
);
INSERT INTO sanity_orders (id, order_no) VALUES (1, 'A-0001');

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='sanity_orders' AND column_name='order_no' AND character_maximum_length=32
-- END_CHECK

-- +migrate Down
DROP TABLE sanity_orders;
