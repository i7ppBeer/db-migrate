-- 混合測試：多種管理員危險操作
-- 預期驗證結果：失敗（包含多種 DCL 危險指令）

-- +migrate Up
CREATE TABLE IF NOT EXISTS admin_audit (
    id INT AUTO_INCREMENT PRIMARY KEY,
    action VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 危險操作1: 建立使用者
CREATE USER 'backup_admin'@'%' IDENTIFIED BY 'secret123';

-- 危險操作2: 授權
GRANT ALL PRIVILEGES ON *.* TO 'backup_admin'@'%';

-- 危險操作3: 撤銷權限
REVOKE DELETE ON mydb.* FROM 'readonly_user'@'%';

-- 危險操作4: 刷新權限
FLUSH PRIVILEGES;

-- +migrate Down
DROP TABLE IF EXISTS admin_audit;
DROP USER IF EXISTS 'backup_admin'@'%';
