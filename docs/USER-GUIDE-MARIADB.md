# MariaDB/MySQL DDL/DCL 編寫指南

> 本指南說明如何為 MariaDB/MySQL 編寫 DDL (資料定義語言) 和 DCL (資料控制語言) Migration 檔案。

---

## 📋 目錄

1. [檔案類型說明](#1-檔案類型說明)
2. [Versioned vs Repeatable 語法對照](#2-versioned-vs-repeatable-語法對照)
3. [危險指令列表](#3-危險指令列表)
4. [如何允許危險指令](#4-如何允許危險指令)
5. [Docker 環境設定與 CLI 使用](#5-docker-環境設定與-cli-使用)
6. [情境範例教學](#6-情境範例教學)

---

## 1. 檔案類型說明

### DDL (Versioned Migration)
- **用途**：Schema 變更（建表、改欄位、加索引）
- **檔名格式**：`YYYYMMDDHHMMSS-description.sql`
- **特性**：每個檔案只執行一次，有版本順序
- **範例**：`20250101000001-create-users.sql`

### DCL (Repeatable Migration)
- **用途**：權限管理（使用者、角色、授權）
- **檔名格式**：`R__NNN_description.sql`
- **特性**：checksum 變更時重新執行，必須是冪等操作
- **範例**：`R__001_create_app_user.sql`

---

## 2. Versioned vs Repeatable 語法對照

### 📁 Versioned (DDL) - 一次性執行

| 操作類型 | 語法範例 | 說明 |
|---------|---------|------|
| 建立資料表 | `CREATE TABLE users (...)` | ✅ 標準用法 |
| 修改資料表 | `ALTER TABLE users ADD COLUMN email VARCHAR(255)` | ✅ 標準用法 |
| 建立索引 | `CREATE INDEX idx_email ON users(email)` | ✅ 標準用法 |
| 刪除資料表 | `DROP TABLE IF EXISTS temp_table` | ⚠️ 需在 DOWN 區塊 |
| 新增外鍵 | `ALTER TABLE orders ADD FOREIGN KEY (user_id) REFERENCES users(id)` | ✅ 標準用法 |
| 修改欄位 | `ALTER TABLE users MODIFY COLUMN name VARCHAR(500)` | ⚠️ 可能影響資料 |

**檔案結構：**
```sql
-- +migrate Up
CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- +migrate Down
DROP TABLE IF EXISTS users;
```

### 📁 Repeatable (DCL) - 可重複執行

| 操作類型 | 語法範例 | 說明 |
|---------|---------|------|
| 建立使用者 | `CREATE USER IF NOT EXISTS 'app'@'%'` | ✅ 必須冪等 |
| 刪除使用者 | `DROP USER IF EXISTS 'old_user'@'%'` | ✅ 必須冪等 |
| 授權 | `GRANT SELECT ON db.* TO 'app'@'%'` | ✅ 天生冪等 |
| 撤銷權限 | `REVOKE ALL ON db.* FROM 'app'@'%'` | ✅ 天生冪等 |
| 刷新權限 | `FLUSH PRIVILEGES` | ✅ 天生冪等 |
| Stored Procedure | `DROP PROCEDURE IF EXISTS ... CREATE PROCEDURE ...` | ✅ 需用 DELIMITER |
| Function | `DROP FUNCTION IF EXISTS ... CREATE FUNCTION ...` | ✅ 需用 DELIMITER |

**檔案結構：**
```sql
-- @description: Application users management
-- @type: dcl
-- @allow-dangerous: true

CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'password';
GRANT SELECT ON mydb.* TO 'app_readonly'@'%';
FLUSH PRIVILEGES;
```

---

## 3. 危險指令列表

### 🔴 絕對禁止 (Forbidden) - 需 `--allow-forbidden`

| 代碼 | 語法 | 風險說明 |
|-----|------|---------|
| `DROP_DATABASE` | `DROP DATABASE xxx` | 刪除整個資料庫 |
| `DROP_SCHEMA` | `DROP SCHEMA xxx` | 刪除整個 Schema |
| `CREATE_USER` | `CREATE USER 'xxx'@'%'` | 應在 DCL 專案管理 |
| `DROP_USER` | `DROP USER 'xxx'@'%'` | 應在 DCL 專案管理 |
| `ALTER_USER` | `ALTER USER 'xxx'@'%'` | 應在 DCL 專案管理 |
| `SET_PASSWORD` | `SET PASSWORD FOR 'xxx'@'%'` | 應在 DCL 專案管理 |
| `GRANT` | `GRANT xxx ON xxx TO xxx` | 應在 DCL 專案管理 |
| `REVOKE` | `REVOKE xxx ON xxx FROM xxx` | 應在 DCL 專案管理 |
| `FLUSH_PRIVILEGES` | `FLUSH PRIVILEGES` | 應在 DCL 專案管理 |
| `INTO_OUTFILE` | `SELECT ... INTO OUTFILE` | 資料外洩風險 |
| `LOAD_DATA` | `LOAD DATA INFILE` | 資料注入風險 |
| `SHUTDOWN` | `SHUTDOWN` | 關閉資料庫 |
| `SET_GLOBAL` | `SET GLOBAL xxx` | 變更系統設定 |
| `RESET_MASTER` | `RESET MASTER` | 破壞複製設定 |

### 🟠 危險操作 (Dangerous) - 需 `--allow-dangerous` 或 `@allow-dangerous`

| 代碼 | 語法 | 風險說明 | 建議 |
|-----|------|---------|------|
| `TRUNCATE_TABLE` | `TRUNCATE TABLE xxx` | 清空全表資料 | 用 DELETE + WHERE |
| `DELETE_ALL` | `DELETE FROM xxx` (無 WHERE) | 刪除全表資料 | 加上 WHERE 條件 |
| `UPDATE_ALL` | `UPDATE xxx SET ...` (無 WHERE) | 更新全表資料 | 加上 WHERE 條件 |
| `DROP_COLUMN` | `ALTER TABLE xxx DROP COLUMN` | 永久刪除欄位 | 先確認無使用 |
| `DROP_INDEX` | `DROP INDEX xxx` | 影響查詢效能 | 先確認無查詢使用 |
| `RENAME_TABLE` | `RENAME TABLE xxx` | 破壞應用程式 | 確認所有引用已更新 |
| `MODIFY_COLUMN` | `MODIFY COLUMN xxx` | 資料轉換失敗 | 先在測試環境驗證 |
| `LOCK_TABLE` | `LOCK TABLE xxx` | 阻塞所有查詢 | 使用交易或行鎖 |
| `ALTER_TABLE_BLOCKING` | `ALTER TABLE` (無 ALGORITHM) | 長時間鎖表 | 用 ALGORITHM=INPLACE |
| `INSERT_SELECT` | `INSERT ... SELECT` | 鎖定來源表 | 分批處理 |

### 🟡 警告提示 (Warnings) - 不阻擋但提醒

| 語法 | 警告說明 |
|------|---------|
| `ALTER TABLE ADD COLUMN` | 大表上可能需要較長時間 |
| `ADD NOT NULL` (無 DEFAULT) | 建議搭配 DEFAULT 值 |
| `AUTO_INCREMENT=xxx` | 手動設定可能造成 ID 衝突 |
| `ENGINE=MyISAM` | 不支援交易，建議用 InnoDB |
| `CHARSET=latin1/utf8` | 建議使用 utf8mb4 |
| `FLOAT/DOUBLE` | 精度問題，金額建議用 DECIMAL |
| `ON DELETE CASCADE` | 可能造成連鎖刪除 |

---

## 4. 如何允許危險指令

### 方法一：在檔案中加入 Annotation（推薦）

```sql
-- @description: 資料清理腳本
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: TRUNCATE_TABLE,DELETE_ALL

TRUNCATE TABLE temp_logs;
DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);
```

### 方法二：CLI 參數

```bash
# 允許所有危險操作
docker compose run --rm migrate dcl --validate --allow-dangerous -c <config>

# 允許所有禁止操作（需團隊審批）
docker compose run --rm migrate dcl --validate --allow-forbidden -c <config>

# 允許特定操作代碼
docker compose run --rm migrate validate --allow TRUNCATE_TABLE,DROP_INDEX -c <config>
```

### Annotation 完整說明

| Annotation | 值 | 說明 |
|------------|---|------|
| `@allow-dangerous` | `true` / `false` | 允許所有危險操作 |
| `@allow-forbidden` | `true` / `false` | 允許所有禁止操作 |
| `@allow` | `CODE1,CODE2,...` | 允許特定操作代碼 |
| `@description` | 文字 | 描述此 migration |
| `@type` | `procedure` / `maintenance` / `dcl` | 類型標記 |

---

## 5. Docker 環境設定與 CLI 使用

### 5.1 取得 Docker Image

```bash
# 方法一：從 Registry 拉取（如果已發布）
docker pull your-registry/ddl-migrate:latest

# 方法二：本地建置
git clone https://github.com/your-org/ddl-migrate.git
cd ddl-migrate
docker compose build migrate
```

### 5.2 本地環境準備

**目錄結構：**
```
your-project/
├── docker-compose.yml
└── databases/
    └── mariadb/
        └── your-project/
            ├── ddl/
            │   ├── config.js
            │   └── migrations/
            │       ├── 20250101000001-create-users.sql
            │       └── 20250101000002-create-orders.sql
            └── dcl/
                ├── config.js
                └── migrations/
                    ├── R__001_app_users.sql
                    └── R__002_readonly_users.sql
```

**config.js 範例：**
```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'mariadb',
    port: parseInt(process.env.MARIADB_PORT || '3306', 10),
    database: process.env.MARIADB_DB || 'your_database',
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password'
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'  // DDL 用
  // checksumTable: '_dcl_migrations'  // DCL 用
};
```

### 5.3 CLI 命令大全

```bash
# ═══════════════════════════════════════════════════════════
# DDL (Versioned) 操作
# ═══════════════════════════════════════════════════════════

# 查看狀態
docker compose run --rm migrate status -c /app/databases/mariadb/your-project/ddl/config.js

# 執行遷移
docker compose run --rm migrate up -c /app/databases/mariadb/your-project/ddl/config.js

# Dry Run（預覽）
docker compose run --rm migrate up --dry-run -c /app/databases/mariadb/your-project/ddl/config.js

# 回滾 1 個遷移
docker compose run --rm migrate down -n 1 -c /app/databases/mariadb/your-project/ddl/config.js

# 驗證遷移檔案
docker compose run --rm migrate validate -c /app/databases/mariadb/your-project/ddl/config.js

# 建立新的 DDL 遷移檔案
docker compose run --rm migrate create "add-email-to-users" -c /app/databases/mariadb/your-project/ddl/config.js

# ═══════════════════════════════════════════════════════════
# DCL (Repeatable) 操作
# ═══════════════════════════════════════════════════════════

# 查看 DCL 狀態
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/your-project/dcl/config.js

# 執行 DCL（無驗證）
docker compose run --rm migrate dcl -c /app/databases/mariadb/your-project/dcl/config.js

# 執行 DCL（啟用驗證）
docker compose run --rm migrate dcl --validate -c /app/databases/mariadb/your-project/dcl/config.js

# 執行 DCL（允許危險操作）
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/databases/mariadb/your-project/dcl/config.js

# Dry Run（預覽）
docker compose run --rm migrate dcl --dry-run -c /app/databases/mariadb/your-project/dcl/config.js

# 建立新的 DCL 遷移檔案
docker compose run --rm migrate create-dcl "create-app-user" -n 001 -c /app/databases/mariadb/your-project/dcl/config.js
```

---

## 6. 情境範例教學

### 情境 1：建立新資料表 (DDL)

**檔案**：`20250126000001-create-products.sql`

```sql
-- +migrate Up
CREATE TABLE products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    stock INT NOT NULL DEFAULT 0,
    category_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_category (category_id),
    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- +migrate Down
DROP TABLE IF EXISTS products;
```

### 情境 2：修改現有資料表 (DDL)

**檔案**：`20250126000002-add-product-description.sql`

```sql
-- +migrate Up
ALTER TABLE products 
    ADD COLUMN description TEXT AFTER name,
    ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE AFTER stock;

CREATE INDEX idx_is_active ON products(is_active);

-- +migrate Down
DROP INDEX idx_is_active ON products;
ALTER TABLE products 
    DROP COLUMN description,
    DROP COLUMN is_active;
```

### 情境 3：建立應用程式使用者 (DCL)

**檔案**：`R__001_app_users.sql`

```sql
-- @description: Application database users
-- @type: dcl

-- ========================================
-- Read-Only User (for reporting)
-- ========================================
CREATE USER IF NOT EXISTS 'app_readonly'@'%' IDENTIFIED BY 'readonly_password_here';

-- Revoke all first (ensure clean state)
REVOKE ALL PRIVILEGES ON *.* FROM 'app_readonly'@'%';

-- Grant read-only access
GRANT SELECT ON your_database.* TO 'app_readonly'@'%';

-- ========================================
-- Read-Write User (for application)
-- ========================================
CREATE USER IF NOT EXISTS 'app_readwrite'@'%' IDENTIFIED BY 'readwrite_password_here';

REVOKE ALL PRIVILEGES ON *.* FROM 'app_readwrite'@'%';

GRANT SELECT, INSERT, UPDATE, DELETE ON your_database.* TO 'app_readwrite'@'%';

-- ========================================
-- Apply changes
-- ========================================
FLUSH PRIVILEGES;
```

### 情境 4：建立 Stored Procedure (DCL)

**檔案**：`R__010_stored_procedures.sql`

```sql
-- @description: Application stored procedures
-- @type: procedure
-- @allow-dangerous: true

-- ========================================
-- Function: Calculate age from birthdate
-- ========================================
DELIMITER //

DROP FUNCTION IF EXISTS fn_calculate_age//

CREATE FUNCTION fn_calculate_age(birthdate DATE)
RETURNS INT
DETERMINISTIC
BEGIN
    RETURN TIMESTAMPDIFF(YEAR, birthdate, CURDATE());
END//

DELIMITER ;

-- ========================================
-- Procedure: Get user order statistics
-- ========================================
DELIMITER //

DROP PROCEDURE IF EXISTS sp_get_user_order_stats//

CREATE PROCEDURE sp_get_user_order_stats(
    IN p_user_id INT,
    OUT p_order_count INT,
    OUT p_total_spent DECIMAL(10,2)
)
BEGIN
    SELECT 
        COUNT(*),
        COALESCE(SUM(total_amount), 0)
    INTO 
        p_order_count,
        p_total_spent
    FROM orders
    WHERE user_id = p_user_id;
END//

DELIMITER ;

-- ========================================
-- Procedure: Archive old orders
-- ========================================
DELIMITER $$

DROP PROCEDURE IF EXISTS sp_archive_old_orders$$

CREATE PROCEDURE sp_archive_old_orders(IN p_days_old INT)
BEGIN
    DECLARE v_cutoff_date DATE;
    SET v_cutoff_date = DATE_SUB(CURDATE(), INTERVAL p_days_old DAY);
    
    -- Create archive table if not exists
    CREATE TABLE IF NOT EXISTS orders_archive LIKE orders;
    
    -- Move old orders to archive
    INSERT INTO orders_archive
    SELECT * FROM orders 
    WHERE order_date < v_cutoff_date
    AND id NOT IN (SELECT id FROM orders_archive);
    
    -- Delete archived orders
    DELETE FROM orders 
    WHERE order_date < v_cutoff_date
    AND id IN (SELECT id FROM orders_archive);
    
    SELECT ROW_COUNT() AS archived_count;
END$$

DELIMITER ;
```

### 情境 5：危險操作 - 資料清理 (DCL)

**檔案**：`R__020_data_cleanup.sql`

```sql
-- @description: Periodic data cleanup job
-- @type: maintenance
-- @allow-dangerous: true
-- @allow: DELETE_ALL,TRUNCATE_TABLE

-- ========================================
-- Clean up temporary tables
-- ========================================

-- Truncate temp processing table (safe - no important data)
TRUNCATE TABLE temp_processing_queue;

-- ========================================
-- Archive and clean old audit logs (90 days)
-- ========================================

-- First, ensure archive table exists
CREATE TABLE IF NOT EXISTS audit_logs_archive LIKE audit_logs;

-- Archive old logs
INSERT IGNORE INTO audit_logs_archive
SELECT * FROM audit_logs 
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY);

-- Delete archived logs from main table
DELETE FROM audit_logs 
WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)
AND id IN (SELECT id FROM audit_logs_archive);

-- ========================================
-- Clean up expired sessions
-- ========================================
DELETE FROM user_sessions 
WHERE expires_at < NOW();
```

### 情境 6：帶有 Sanity Check 的 Migration (DDL)

**檔案**：`20250126000003-add-phone-with-sanity.sql`

```sql
-- +migrate Up

-- +sanity PreCheck
-- EXPECT_NO_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PreCheck

ALTER TABLE users ADD COLUMN phone VARCHAR(20) AFTER email;

-- +sanity PostCheck
-- EXPECT_ROWS: SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'phone'
-- -sanity PostCheck

-- +migrate Down
ALTER TABLE users DROP COLUMN phone;
```

### 情境 7：多環境權限管理 (DCL)

**檔案**：`R__003_environment_users.sql`

```sql
-- @description: Environment-specific users with dynamic passwords
-- @type: dcl

-- ========================================
-- Development Environment User
-- ========================================
CREATE USER IF NOT EXISTS 'dev_user'@'%' 
    IDENTIFIED BY 'dev_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'dev_user'@'%';
GRANT ALL PRIVILEGES ON dev_%.* TO 'dev_user'@'%';

-- ========================================
-- Staging Environment User  
-- ========================================
CREATE USER IF NOT EXISTS 'staging_user'@'%' 
    IDENTIFIED BY 'staging_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'staging_user'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON staging_%.* TO 'staging_user'@'%';

-- ========================================
-- Production Read-Only User (for BI tools)
-- ========================================
CREATE USER IF NOT EXISTS 'bi_readonly'@'10.0.%' 
    IDENTIFIED BY 'bi_password_change_me';

REVOKE ALL PRIVILEGES ON *.* FROM 'bi_readonly'@'10.0.%';
GRANT SELECT ON production_db.* TO 'bi_readonly'@'10.0.%';

-- Disallow access to sensitive tables
REVOKE SELECT ON production_db.user_passwords FROM 'bi_readonly'@'10.0.%';
REVOKE SELECT ON production_db.payment_info FROM 'bi_readonly'@'10.0.%';

FLUSH PRIVILEGES;
```

---

## 📝 最佳實踐

1. **DDL 檔案一定要有 Down 區塊**，確保可以回滾
2. **DCL 檔案必須是冪等的**，使用 `IF EXISTS` / `IF NOT EXISTS`
3. **大表操作加上 ALGORITHM=INPLACE**，避免長時間鎖表
4. **密碼不要硬編碼**，使用環境變數或 Secret Management
5. **危險操作要有明確的 Annotation**，說明為什麼需要
6. **測試環境先跑過**，再到正式環境執行

---

## 🔗 相關文件

- [CLI 使用指南](CLI-USAGE-GUIDE.md)
- [Docker Compose 使用指南](DOCKER-COMPOSE-USER-GUIDE.md)
- [Migration 管理指南](MIGRATION-MANAGEMENT-GUIDE.md)
