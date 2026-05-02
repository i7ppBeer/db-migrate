-- 測試：RENAME TABLE 搭配 DROP DATABASE
-- 預期驗證結果：失敗（DROP DATABASE 是最危險的操作）

-- +migrate Up
CREATE TABLE IF NOT EXISTS migration_temp (
    id INT AUTO_INCREMENT PRIMARY KEY,
    status VARCHAR(50)
);

-- 正常操作：重命名表
RENAME TABLE migration_temp TO migration_final;

-- 危險操作：刪除整個資料庫
DROP DATABASE IF EXISTS old_backup_db;

-- 另一個危險變體
DROP SCHEMA IF EXISTS legacy_schema;

-- +migrate Down
DROP TABLE IF EXISTS migration_final;
