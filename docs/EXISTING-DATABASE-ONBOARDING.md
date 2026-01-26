# 既有資料庫導入 SOP (Existing Database Onboarding)

本文檔說明如何將**既有的資料庫**（已有 Schema 和資料）導入 ddl-migrate 工具進行管理。

---

## 目錄

1. [導入流程總覽](#1-導入流程總覽)
2. [Step 1: 環境準備](#2-step-1-環境準備)
3. [Step 2: 匯出現有 Schema](#3-step-2-匯出現有-schema)
4. [Step 3: 建立 Baseline Migration](#4-step-3-建立-baseline-migration)
5. [Step 4: 建立 DCL (使用者/權限)](#5-step-4-建立-dcl-使用者權限)
6. [Step 5: 執行 Baseline](#6-step-5-執行-baseline)
7. [Step 6: 驗證導入結果](#7-step-6-驗證導入結果)
8. [後續開發流程](#8-後續開發流程)
9. [常見問題](#9-常見問題)

---

## 1. 導入流程總覽

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    既有資料庫導入流程 (Onboarding Flow)                       │
└─────────────────────────────────────────────────────────────────────────────┘

           既有資料庫                                    Migration 管理
    ┌──────────────────┐                          ┌──────────────────────┐
    │  • Tables        │                          │  databases/          │
    │  • Indexes       │                          │  └── mariadb/        │
    │  • Views         │                          │      └── my-project/ │
    │  • Procedures    │    ══════════════▶       │          ├── ddl/    │
    │  • Users         │       導入流程            │          │   └── migrations/
    │  • Permissions   │                          │          └── dcl/    │
    └──────────────────┘                          │              └── migrations/
                                                  └──────────────────────┘

    ┌─────────────────────────────────────────────────────────────────────────┐
    │                            導入步驟                                      │
    │                                                                         │
    │   Step 1         Step 2          Step 3          Step 4         Step 5  │
    │  ┌────────┐    ┌────────┐      ┌────────┐      ┌────────┐     ┌────────┐│
    │  │環境準備 │───▶│匯出Schema│───▶│建立DDL  │───▶│建立DCL  │───▶│執行     ││
    │  │        │    │        │      │Baseline│      │Baseline│     │Baseline││
    │  └────────┘    └────────┘      └────────┘      └────────┘     └────────┘│
    │       │              │               │               │              │    │
    │       ▼              ▼               ▼               ▼              ▼    │
    │   建立目錄     mysqldump /     V1__baseline     R__001_users    baseline │
    │   config.js    mongodump       .sql/.js        .sql/.js        --all    │
    │                                                                         │
    └─────────────────────────────────────────────────────────────────────────┘

    ┌─────────────────────────────────────────────────────────────────────────┐
    │                         驗證與後續開發                                    │
    │                                                                         │
    │   Step 6                    後續開發                                     │
    │  ┌────────┐              ┌────────────────────────────────────┐         │
    │  │驗證結果 │              │ V2__add_xxx.sql                    │         │
    │  │status  │    ─────▶    │ V3__modify_xxx.sql                 │         │
    │  │        │   開始正常開發 │ R__002_new_users.sql               │         │
    │  └────────┘              └────────────────────────────────────┘         │
    └─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Step 1: 環境準備

### 2.1 建立專案目錄結構

```bash
# MariaDB 專案結構
mkdir -p databases/mariadb/my-project/{ddl,dcl}/migrations

# 或 MongoDB 專案結構
mkdir -p databases/mongodb/my-project/{ddl,dcl}/migrations
```

### 2.2 建立 DDL config.js

**MariaDB (`databases/mariadb/my-project/ddl/config.js`):**

```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306'),
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password',
    database: process.env.MARIADB_DATABASE || 'my_database',
    multipleStatements: true
  },
  migrationsDir: './migrations',
  changelogTable: '_migrations'
};
```

**MongoDB (`databases/mongodb/my-project/ddl/config.js`):**

```javascript
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://localhost:27017',
    databaseName: process.env.MONGODB_DB || 'my_database',
    options: {}
  },
  migrationsDir: './migrations',
  changelogCollectionName: 'changelog'
};
```

### 2.3 建立 DCL config.js

**MariaDB (`databases/mariadb/my-project/dcl/config.js`):**

```javascript
export default {
  type: 'mariadb',
  mariadb: {
    host: process.env.MARIADB_HOST || 'localhost',
    port: parseInt(process.env.MARIADB_PORT || '3306'),
    user: process.env.MARIADB_USER || 'root',
    password: process.env.MARIADB_PASSWORD || 'password',
    database: process.env.MARIADB_DATABASE || 'my_database',
    multipleStatements: true
  },
  migrationsDir: './migrations',
  checksumTable: '_dcl_migrations'
};
```

---

## 3. Step 2: 匯出現有 Schema

### 3.1 MariaDB Schema 匯出

```bash
# 匯出 Schema (不含資料)
mysqldump -h localhost -u root -p \
  --no-data \
  --routines \
  --triggers \
  --skip-comments \
  my_database > schema-export.sql

# 只匯出特定表
mysqldump -h localhost -u root -p \
  --no-data \
  my_database users products orders > schema-export.sql

# 匯出使用者和權限
mysql -h localhost -u root -p -N -e "
  SELECT CONCAT('-- User: ', user, '@', host) AS comment,
         CONCAT('CREATE USER IF NOT EXISTS ''', user, '''@''', host, ''' IDENTIFIED BY ''password'';') AS create_stmt
  FROM mysql.user 
  WHERE user NOT IN ('root', 'mysql.sys', 'mysql.session', 'mysql.infoschema', 'mariadb.sys')
" > users-export.sql

mysql -h localhost -u root -p -N -e "
  SHOW GRANTS FOR 'app_user'@'%';
" >> users-export.sql
```

### 3.2 MongoDB Schema 匯出

```bash
# 匯出所有 Collection 的 indexes 和 validators
mongosh my_database --eval '
  db.getCollectionNames().forEach(function(coll) {
    print("// Collection: " + coll);
    
    // Indexes
    var indexes = db.getCollection(coll).getIndexes();
    indexes.forEach(function(idx) {
      if (idx.name !== "_id_") {
        print("db." + coll + ".createIndex(" + JSON.stringify(idx.key) + ", " + 
              JSON.stringify({name: idx.name, unique: idx.unique || false}) + ");");
      }
    });
    
    // Validation
    var info = db.getCollectionInfos({name: coll})[0];
    if (info && info.options && info.options.validator) {
      print("// Validator: " + JSON.stringify(info.options.validator));
    }
    print("");
  });
' > schema-export.js
```

### 3.3 使用 Docker 匯出

```bash
# MariaDB (Docker Compose)
docker compose exec mariadb mysqldump \
  -u root -prootpass \
  --no-data \
  --routines \
  my_database > schema-export.sql

# MongoDB (Docker Compose)
docker compose exec mongodb mongosh my_database --eval '...' > schema-export.js
```

---

## 4. Step 3: 建立 Baseline Migration

### 4.1 MariaDB Baseline

**檔案：`databases/mariadb/my-project/ddl/migrations/20250101000000-baseline.sql`**

```sql
-- +migrate Up
-- ═══════════════════════════════════════════════════════════════
-- Baseline Migration - 既有 Schema 初始化
-- 建立時間: 2025-01-26
-- 說明: 此檔案包含資料庫導入時的既有 Schema
--       不會實際執行，僅用於記錄基準狀態
-- ═══════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- Table: users
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    email VARCHAR(100) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    UNIQUE KEY uk_username (username),
    UNIQUE KEY uk_email (email),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────
-- Table: products
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    stock INT UNSIGNED DEFAULT 0,
    category_id BIGINT UNSIGNED,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_category (category_id),
    INDEX idx_price (price)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────
-- Table: orders
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    status ENUM('pending', 'paid', 'shipped', 'completed', 'cancelled') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────
-- Stored Procedures (如果有)
-- ─────────────────────────────────────────────────────────────────
DELIMITER //

CREATE PROCEDURE IF NOT EXISTS sp_get_user_orders(IN p_user_id BIGINT)
BEGIN
    SELECT o.*, u.username
    FROM orders o
    JOIN users u ON o.user_id = u.id
    WHERE o.user_id = p_user_id
    ORDER BY o.created_at DESC;
END //

DELIMITER ;

-- +migrate Down
-- ⚠️ Baseline 不支援 Down (會刪除所有資料)
-- 如需還原，請使用資料庫備份

DROP PROCEDURE IF EXISTS sp_get_user_orders;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS users;
```

### 4.2 MongoDB Baseline

**檔案：`databases/mongodb/my-project/ddl/migrations/20250101000000-baseline.js`**

```javascript
/**
 * Baseline Migration - 既有 Schema 初始化
 * 建立時間: 2025-01-26
 * 說明: 此檔案包含資料庫導入時的既有 Schema
 *       不會實際執行，僅用於記錄基準狀態
 */

export async function up(db, client) {
  // ═══════════════════════════════════════════════════════════════
  // Collection: users
  // ═══════════════════════════════════════════════════════════════
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    await db.createCollection('users', {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['username', 'email'],
          properties: {
            username: { bsonType: 'string', minLength: 1 },
            email: { bsonType: 'string', pattern: '^.+@.+$' },
            status: { enum: ['active', 'inactive', 'suspended'] }
          }
        }
      }
    });
  }
  
  // Indexes for users
  await db.collection('users').createIndex({ username: 1 }, { unique: true, name: 'uk_username' });
  await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'uk_email' });
  await db.collection('users').createIndex({ status: 1 }, { name: 'idx_status' });
  await db.collection('users').createIndex({ createdAt: 1 }, { name: 'idx_createdAt' });

  // ═══════════════════════════════════════════════════════════════
  // Collection: products
  // ═══════════════════════════════════════════════════════════════
  const productsExists = await db.listCollections({ name: 'products' }).toArray();
  if (productsExists.length === 0) {
    await db.createCollection('products');
  }
  
  await db.collection('products').createIndex({ categoryId: 1 }, { name: 'idx_category' });
  await db.collection('products').createIndex({ price: 1 }, { name: 'idx_price' });

  // ═══════════════════════════════════════════════════════════════
  // Collection: orders
  // ═══════════════════════════════════════════════════════════════
  const ordersExists = await db.listCollections({ name: 'orders' }).toArray();
  if (ordersExists.length === 0) {
    await db.createCollection('orders');
  }
  
  await db.collection('orders').createIndex({ userId: 1 }, { name: 'idx_userId' });
  await db.collection('orders').createIndex({ status: 1 }, { name: 'idx_status' });
  await db.collection('orders').createIndex({ createdAt: 1 }, { name: 'idx_createdAt' });
}

export async function down(db, client) {
  // ⚠️ Baseline 不建議執行 Down (會刪除所有資料)
  // 如需還原，請使用資料庫備份
  
  await db.collection('orders').drop().catch(() => {});
  await db.collection('products').drop().catch(() => {});
  await db.collection('users').drop().catch(() => {});
}
```

---

## 5. Step 4: 建立 DCL (使用者/權限)

### 5.1 MariaDB DCL

**檔案：`databases/mariadb/my-project/dcl/migrations/R__001_app_users.sql`**

```sql
-- ═══════════════════════════════════════════════════════════════
-- DCL: Application Users
-- 說明: 應用程式使用的資料庫帳號
-- ═══════════════════════════════════════════════════════════════
-- @allow-dangerous: true
-- @description: 建立應用程式帳號

-- 應用程式帳號 (讀寫)
CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'app_password_here';

-- 授予權限
GRANT SELECT, INSERT, UPDATE, DELETE ON my_database.* TO 'app_user'@'%';

-- 儲存程序執行權限 (如果有)
GRANT EXECUTE ON my_database.* TO 'app_user'@'%';

FLUSH PRIVILEGES;
```

**檔案：`databases/mariadb/my-project/dcl/migrations/R__002_readonly_users.sql`**

```sql
-- ═══════════════════════════════════════════════════════════════
-- DCL: Read-only Users
-- 說明: 報表或分析用的唯讀帳號
-- ═══════════════════════════════════════════════════════════════
-- @allow-dangerous: true
-- @description: 建立唯讀帳號

-- 唯讀帳號
CREATE USER IF NOT EXISTS 'readonly_user'@'%' IDENTIFIED BY 'readonly_password_here';

-- 只授予 SELECT 權限
GRANT SELECT ON my_database.* TO 'readonly_user'@'%';

FLUSH PRIVILEGES;
```

### 5.2 MongoDB DCL

**檔案：`databases/mongodb/my-project/dcl/migrations/R__001_app_users.js`**

```javascript
/**
 * DCL: Application Users
 * 說明: 應用程式使用的資料庫帳號
 * @allow-dangerous: true
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // 建立應用程式帳號 (讀寫)
  try {
    await adminDb.command({
      createUser: 'app_user',
      pwd: 'app_password_here',
      roles: [
        { role: 'readWrite', db: 'my_database' }
      ]
    });
  } catch (error) {
    if (error.code !== 51003) { // User already exists
      throw error;
    }
    // Update existing user
    await adminDb.command({
      updateUser: 'app_user',
      pwd: 'app_password_here',
      roles: [
        { role: 'readWrite', db: 'my_database' }
      ]
    });
  }
}

export async function down(db, client) {
  const adminDb = client.db('admin');
  try {
    await adminDb.command({ dropUser: 'app_user' });
  } catch (error) {
    // Ignore if user doesn't exist
  }
}
```

---

## 6. Step 5: 執行 Baseline

### 6.1 使用 baseline 命令 (推薦)

```bash
# 查看有哪些 migration 檔案
docker compose run --rm migrate baseline -c /app/databases/mariadb/my-project/ddl/config.js

# 標記所有 DDL 為已執行 (不實際執行 SQL)
docker compose run --rm migrate baseline --all -c /app/databases/mariadb/my-project/ddl/config.js

# 只標記到某個版本
docker compose run --rm migrate baseline --up-to 20250101000000-baseline -c /app/databases/mariadb/my-project/ddl/config.js

# 預覽 (不實際標記)
docker compose run --rm migrate baseline --all --dry-run -c /app/databases/mariadb/my-project/ddl/config.js
```

### 6.2 DCL 首次執行

```bash
# DCL 需要實際執行 (建立使用者/權限)
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/databases/mariadb/my-project/dcl/config.js
```

### 6.3 完整導入腳本

```bash
#!/bin/bash
# onboard-existing-db.sh
# 既有資料庫導入腳本

set -e

PROJECT=${1:-my-project}
DB_TYPE=${2:-mariadb}

echo "═══════════════════════════════════════════════════════════"
echo "  Onboarding Existing Database: ${PROJECT}"
echo "  Database Type: ${DB_TYPE}"
echo "═══════════════════════════════════════════════════════════"

DDL_CONFIG="/app/databases/${DB_TYPE}/${PROJECT}/ddl/config.js"
DCL_CONFIG="/app/databases/${DB_TYPE}/${PROJECT}/dcl/config.js"

# Step 1: 確認資料庫連線
echo ""
echo "Step 1: 確認資料庫連線..."
docker compose run --rm migrate status -c $DDL_CONFIG

# Step 2: 標記 DDL Baseline
echo ""
echo "Step 2: 標記 DDL Baseline..."
docker compose run --rm migrate baseline --all -c $DDL_CONFIG

# Step 3: 驗證 DDL 狀態
echo ""
echo "Step 3: 驗證 DDL 狀態..."
docker compose run --rm migrate status -c $DDL_CONFIG

# Step 4: 執行 DCL (建立帳號)
echo ""
echo "Step 4: 執行 DCL..."
docker compose run --rm migrate dcl --validate --allow-dangerous -c $DCL_CONFIG

# Step 5: 驗證 DCL 狀態
echo ""
echo "Step 5: 驗證 DCL 狀態..."
docker compose run --rm migrate dcl:status -c $DCL_CONFIG

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✅ 導入完成！"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "後續開發請使用:"
echo "  # 建立新的 DDL migration"
echo "  docker compose run --rm migrate create 'add-xxx-table' -c $DDL_CONFIG"
echo ""
echo "  # 執行 migration"
echo "  docker compose run --rm migrate up -c $DDL_CONFIG"
```

---

## 7. Step 6: 驗證導入結果

### 7.1 檢查 DDL 狀態

```bash
docker compose run --rm migrate status -c /app/databases/mariadb/my-project/ddl/config.js
```

**預期輸出：**
```
[STATUS] Database: mariadb
──────────────────────────────────────────────────

✅ Applied (1):
   20250101000000-baseline.sql - Mon Jan 26 2026 10:00:00 GMT+0000

⏳ Pending (0):
   (none)
```

### 7.2 檢查 DCL 狀態

```bash
docker compose run --rm migrate dcl:status -c /app/databases/mariadb/my-project/dcl/config.js
```

### 7.3 驗證資料庫帳號

```bash
# MariaDB - 檢查使用者
docker compose exec mariadb mariadb -u root -prootpass -e "SELECT user, host FROM mysql.user WHERE user LIKE 'app%' OR user LIKE 'readonly%';"

# MongoDB - 檢查使用者
docker compose exec mongodb mongosh admin --eval "db.getUsers()"
```

---

## 8. 後續開發流程

導入完成後，後續的開發流程如下：

### 8.1 建立新的 DDL Migration

```bash
# 建立新的 migration 檔案
docker compose run --rm migrate create 'add-user-profile-table' -c /app/databases/mariadb/my-project/ddl/config.js

# 編輯檔案: 20250126100000-add-user-profile-table.sql
```

### 8.2 執行 Migration

```bash
# 預覽
docker compose run --rm migrate up --dry-run -c /app/databases/mariadb/my-project/ddl/config.js

# 執行
docker compose run --rm migrate up -c /app/databases/mariadb/my-project/ddl/config.js
```

### 8.3 新增 DCL

```bash
# 建立新的 DCL 檔案
docker compose run --rm migrate create-dcl 'new-service-account' -n 003 -c /app/databases/mariadb/my-project/dcl/config.js

# 執行
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/databases/mariadb/my-project/dcl/config.js
```

---

## 9. 常見問題

### Q1: Baseline 會執行 SQL 嗎？

**A:** 不會。`baseline` 命令只會在 changelog 表中記錄該 migration 已執行，不會實際執行 SQL 內容。這是因為既有資料庫已經有這些 Schema 了。

### Q2: 如果 Baseline 檔案的 Schema 與實際不符怎麼辦？

**A:** Baseline 檔案主要用於記錄「這是起始狀態」，即使與實際 Schema 有些許差異，也不影響後續的增量 migration。但建議盡量保持一致，方便未來參考。

### Q3: 可以有多個 Baseline 檔案嗎？

**A:** 可以，但不建議。通常一個 baseline 檔案就夠了。如果 Schema 太大，可以拆成多個檔案：
- `20250101000001-baseline-users.sql`
- `20250101000002-baseline-products.sql`
- `20250101000003-baseline-orders.sql`

### Q4: DCL 需要 Baseline 嗎？

**A:** DCL 使用 Repeatable (R__) 格式，不需要 baseline。每次執行都會重新套用（冪等性），所以只要建立正確的 DCL 檔案並執行即可。

### Q5: 如何處理多環境（DEV/STG/PROD）？

**A:** 
1. 每個環境使用相同的 migration 檔案
2. 透過環境變數切換資料庫連線
3. 先在 DEV 測試，再推到 STG/PROD

```bash
# DEV
MARIADB_HOST=dev-db.example.com ./scripts/onboard-existing-db.sh

# PROD
MARIADB_HOST=prod-db.example.com ./scripts/onboard-existing-db.sh
```

### Q6: 導入後發現漏掉了某個 Table 怎麼辦？

**A:** 建立新的 migration 來補上：

```bash
# 建立補充 migration
docker compose run --rm migrate create 'add-missing-audit-table' -c /app/databases/mariadb/my-project/ddl/config.js
```

### Q7: 如何回滾到 Baseline 之前？

**A:** 不建議這樣做。如果真的需要，請：
1. 使用資料庫備份還原
2. 清空 changelog 表
3. 重新執行 baseline

---

## 快速參考卡

```bash
# ═══════════════════════════════════════════════════════════════
# 既有資料庫導入 - 快速指令
# ═══════════════════════════════════════════════════════════════

# 1. 建立目錄
mkdir -p databases/mariadb/my-project/{ddl,dcl}/migrations

# 2. 建立 config.js (複製模板並修改)
cp databases/mariadb/_templates/ddl/config.js databases/mariadb/my-project/ddl/
cp databases/mariadb/_templates/dcl/config.js databases/mariadb/my-project/dcl/

# 3. 匯出現有 Schema 並建立 baseline 檔案
# ... (手動編輯)

# 4. 標記 Baseline
docker compose run --rm migrate baseline --all \
  -c /app/databases/mariadb/my-project/ddl/config.js

# 5. 執行 DCL
docker compose run --rm migrate dcl --validate --allow-dangerous \
  -c /app/databases/mariadb/my-project/dcl/config.js

# 6. 驗證
docker compose run --rm migrate status \
  -c /app/databases/mariadb/my-project/ddl/config.js

# 後續: 建立新 migration
docker compose run --rm migrate create 'add-xxx' \
  -c /app/databases/mariadb/my-project/ddl/config.js
```
