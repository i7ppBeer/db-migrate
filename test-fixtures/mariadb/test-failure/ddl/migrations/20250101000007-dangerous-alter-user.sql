-- 測試：ALTER USER 危險操作
-- 預期驗證結果：失敗（修改使用者是危險操作）

-- +migrate Up
CREATE TABLE IF NOT EXISTS user_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP
);

-- 危險操作: 修改使用者密碼
ALTER USER 'app_user'@'localhost' IDENTIFIED BY 'newpassword';

-- 危險操作: 設定密碼
SET PASSWORD FOR 'legacy_user'@'%' = 'oldpassword';

-- +migrate Down
DROP TABLE IF EXISTS user_sessions;
