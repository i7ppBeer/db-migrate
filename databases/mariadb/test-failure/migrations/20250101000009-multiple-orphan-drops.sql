-- 測試：多個孤立 DROP TABLE 操作
-- 預期驗證結果：失敗（drop 了未在此 migration 建立的表）

-- +migrate Up
-- 只建立一個表
CREATE TABLE IF NOT EXISTS new_audit_table (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message TEXT
);

-- 但 drop 了多個其他表（孤立 drop）
DROP TABLE IF EXISTS legacy_users;
DROP TABLE IF EXISTS old_products;
DROP TABLE IF EXISTS deprecated_orders;
DROP TABLE IF EXISTS archived_logs;

-- +migrate Down
DROP TABLE IF EXISTS new_audit_table;
