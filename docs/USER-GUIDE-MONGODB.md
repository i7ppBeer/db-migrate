# MongoDB DDL/DCL 編寫指南

> 本指南說明如何為 MongoDB 編寫 DDL (資料定義語言) 和 DCL (資料控制語言) Migration 檔案。

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
- **用途**：Schema 變更（建立 Collection、Index、Validation）
- **檔名格式**：`YYYYMMDDHHMMSS-description.js`
- **特性**：每個檔案只執行一次，有版本順序
- **範例**：`20250101000001-create-users.js`

### DCL (Repeatable Migration)
- **用途**：權限管理（使用者、角色、授權）
- **檔名格式**：`R__NNN_description.js`
- **特性**：checksum 變更時重新執行，必須是冪等操作
- **範例**：`R__001_create_app_user.js`

---

## 2. Versioned vs Repeatable 語法對照

### 📁 Versioned (DDL) - 一次性執行

| 操作類型 | 語法範例 | 說明 |
|---------|---------|------|
| 建立 Collection | `db.createCollection('users')` | ✅ 標準用法 |
| 建立索引 | `db.collection('users').createIndex({email: 1})` | ✅ 標準用法 |
| 建立唯一索引 | `createIndex({email: 1}, {unique: true})` | ✅ 標準用法 |
| 建立複合索引 | `createIndex({status: 1, createdAt: -1})` | ✅ 標準用法 |
| 設定 Schema Validation | `db.command({collMod: ...})` | ✅ 標準用法 |
| 刪除 Collection | `db.collection('xxx').drop()` | ⚠️ 需在 down() |
| 刪除索引 | `db.collection('xxx').dropIndex()` | ⚠️ 危險操作 |
| 插入初始資料 | `db.collection('xxx').insertMany()` | ✅ 標準用法 |

**檔案結構：**
```javascript
export async function up(db, client) {
  await db.createCollection('users');
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, name: 'idx_users_email' }
  );
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### 📁 Repeatable (DCL) - 可重複執行

| 操作類型 | 語法範例 | 說明 |
|---------|---------|------|
| 建立使用者 | `db.command({createUser: ...})` | ✅ 需先檢查存在 |
| 更新使用者 | `db.command({updateUser: ...})` | ✅ 天生冪等 |
| 刪除使用者 | `db.command({dropUser: ...})` | ✅ 需先檢查存在 |
| 建立角色 | `db.command({createRole: ...})` | ✅ 需先檢查存在 |
| 更新角色 | `db.command({updateRole: ...})` | ✅ 天生冪等 |
| 授予角色 | `db.command({grantRolesToUser: ...})` | ✅ 天生冪等 |
| 撤銷角色 | `db.command({revokeRolesFromUser: ...})` | ✅ 天生冪等 |

**檔案結構：**
```javascript
// @description: Application users management
// @type: dcl
// @allow-dangerous: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // Check if user exists
  const users = await adminDb.command({ usersInfo: 'app_readonly' });
  
  if (users.users.length === 0) {
    await adminDb.command({
      createUser: 'app_readonly',
      pwd: 'password',
      roles: [{ role: 'read', db: 'mydb' }]
    });
  } else {
    await adminDb.command({
      updateUser: 'app_readonly',
      roles: [{ role: 'read', db: 'mydb' }]
    });
  }
}

export async function down(db, client) {
  console.log('DCL migrations do not support rollback');
}
```

---

## 3. 危險指令列表

### 🔴 絕對禁止 (Forbidden) - 需 `--allow-forbidden`

| 代碼 | 語法 | 風險說明 |
|-----|------|---------|
| `DROP_DATABASE` | `db.dropDatabase()` | 刪除整個資料庫 |
| `DROP_DATABASE_CMD` | `{ dropDatabase: 1 }` | 刪除整個資料庫 |
| `CREATE_USER` | `db.createUser()` | 應在 DCL 專案管理 |
| `CREATE_USER_CMD` | `{ createUser: ... }` | 應在 DCL 專案管理 |
| `DROP_USER` | `db.dropUser()` | 應在 DCL 專案管理 |
| `DROP_USER_CMD` | `{ dropUser: ... }` | 應在 DCL 專案管理 |
| `UPDATE_USER` | `db.updateUser()` | 應在 DCL 專案管理 |
| `UPDATE_USER_CMD` | `{ updateUser: ... }` | 應在 DCL 專案管理 |
| `GRANT_ROLES` | `db.grantRolesToUser()` | 應在 DCL 專案管理 |
| `REVOKE_ROLES` | `db.revokeRolesFromUser()` | 應在 DCL 專案管理 |
| `CREATE_ROLE` | `db.createRole()` | 應在 DCL 專案管理 |
| `DROP_ROLE` | `db.dropRole()` | 應在 DCL 專案管理 |
| `SHUTDOWN` | `{ shutdown: 1 }` | 關閉資料庫 |
| `REPL_RECONFIG` | `{ replSetReconfig: ... }` | 變更 Replica Set |
| `SET_PARAMETER` | `{ setParameter: ... }` | 變更系統參數 |

### 🟠 危險操作 (Dangerous) - 需 `--allow-dangerous` 或 `@allow-dangerous`

| 代碼 | 語法 | 風險說明 | 建議 |
|-----|------|---------|------|
| `DROP_COLLECTION` | `.drop()` | 刪除整個 Collection | 確認有備份 |
| `DELETE_ALL` | `.deleteMany({})` | 刪除所有文件 | 加上查詢條件 |
| `REMOVE_ALL` | `.remove({})` | 刪除所有文件 | 用 deleteMany + 條件 |
| `UPDATE_ALL` | `.updateMany({}, ...)` | 更新所有文件 | 加上查詢條件 |
| `REPLACE_ONE` | `.replaceOne()` | 完全取代文件 | 用 updateOne + $set |
| `DROP_INDEX` | `.dropIndex()` | 影響查詢效能 | 確認無查詢使用 |
| `DROP_INDEXES` | `.dropIndexes()` | 刪除所有索引 | 非常危險 |
| `RENAME_FIELD` | `{ $rename: ... }` | 破壞應用程式 | 確認引用已更新 |
| `UNSET_FIELD` | `{ $unset: ... }` | 永久刪除欄位 | 確認欄位無使用 |
| `RENAME_COLLECTION` | `.renameCollection()` | 破壞應用程式 | 確認引用已更新 |
| `VALIDATION_ERROR` | `validationAction: "error"` | 寫入失敗 | 先用 "warn" 測試 |
| `VALIDATION_STRICT` | `validationLevel: "strict"` | 驗證所有文件 | 確認資料符合 |

### 🟡 警告提示 (Warnings) - 不阻擋但提醒

| 語法 | 警告說明 |
|------|---------|
| `.createIndex()` | 大 Collection 上可能需要較長時間 |
| `background: false` | 會阻塞操作 |
| `.aggregate()` | 大數據集上可能耗費大量資源 |
| `$lookup` | 可能造成效能問題，確認有適當索引 |
| `sparse: true` | 不會包含 null 值的文件 |
| `expireAfterSeconds` | TTL 索引會自動刪除過期文件 |
| `.deleteMany()` | 可能影響大量資料 |
| `.updateMany()` | 可能影響大量資料 |

---

## 4. 如何允許危險指令

### 方法一：在檔案中加入 Annotation（推薦）

```javascript
// @description: 資料清理腳本
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL

export async function up(db, client) {
  // 建立 temp collection 以便後續刪除不是 orphan drop
  await db.createCollection('temp_data').catch(() => {});
  
  // 現在可以安全刪除
  await db.collection('temp_data').drop();
  
  // 刪除舊的 audit logs
  await db.collection('audit_logs').deleteMany({
    createdAt: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
  });
}

export async function down(db, client) {
  console.log('Repeatable migrations do not support rollback');
}
```

### 方法二：CLI 參數

```bash
# 允許所有危險操作
docker compose run --rm migrate dcl --validate --allow-dangerous -c <config>

# 允許所有禁止操作（需團隊審批）
docker compose run --rm migrate dcl --validate --allow-forbidden -c <config>

# 允許特定操作代碼
docker compose run --rm migrate validate --allow DROP_COLLECTION,DELETE_ALL -c <config>
```

### Annotation 完整說明

| Annotation | 值 | 說明 |
|------------|---|------|
| `@allow-dangerous` | `true` / `false` | 允許所有危險操作 |
| `@allow-forbidden` | `true` / `false` | 允許所有禁止操作 |
| `@allow` | `CODE1,CODE2,...` | 允許特定操作代碼 |
| `@description` | 文字 | 描述此 migration |
| `@type` | `maintenance` / `dcl` | 類型標記 |

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
    └── mongodb/
        └── your-project/
            ├── ddl/
            │   ├── config.js
            │   └── migrations/
            │       ├── 20250101000001-create-users.js
            │       └── 20250101000002-create-orders.js
            └── dcl/
                ├── config.js
                └── migrations/
                    ├── R__001_app_users.js
                    └── R__002_readonly_users.js
```

**config.js 範例：**
```javascript
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://mongodb:27017',
    databaseName: process.env.MONGODB_DB || 'your_database',
    options: {}
  },
  migrationsDir: './migrations',
  changelogCollectionName: 'changelog'  // DDL 用
  // checksumTable: '_dcl_migrations'    // DCL 用
};
```

### 5.3 CLI 命令大全

```bash
# ═══════════════════════════════════════════════════════════
# DDL (Versioned) 操作
# ═══════════════════════════════════════════════════════════

# 查看狀態
docker compose run --rm migrate status -c /app/databases/mongodb/your-project/ddl/config.js

# 執行遷移
docker compose run --rm migrate up -c /app/databases/mongodb/your-project/ddl/config.js

# Dry Run（預覽）
docker compose run --rm migrate up --dry-run -c /app/databases/mongodb/your-project/ddl/config.js

# 回滾 1 個遷移
docker compose run --rm migrate down -n 1 -c /app/databases/mongodb/your-project/ddl/config.js

# 驗證遷移檔案
docker compose run --rm migrate validate -c /app/databases/mongodb/your-project/ddl/config.js

# 建立新的 DDL 遷移檔案
docker compose run --rm migrate create "add-user-profile" -c /app/databases/mongodb/your-project/ddl/config.js

# ═══════════════════════════════════════════════════════════
# DCL (Repeatable) 操作
# ═══════════════════════════════════════════════════════════

# 查看 DCL 狀態
docker compose run --rm migrate dcl:status -c /app/databases/mongodb/your-project/dcl/config.js

# 執行 DCL（無驗證）
docker compose run --rm migrate dcl -c /app/databases/mongodb/your-project/dcl/config.js

# 執行 DCL（啟用驗證）
docker compose run --rm migrate dcl --validate -c /app/databases/mongodb/your-project/dcl/config.js

# 執行 DCL（允許危險操作）
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/databases/mongodb/your-project/dcl/config.js

# Dry Run（預覽）
docker compose run --rm migrate dcl --dry-run -c /app/databases/mongodb/your-project/dcl/config.js

# 建立新的 DCL 遷移檔案
docker compose run --rm migrate create-dcl "create-app-user" -n 001 -c /app/databases/mongodb/your-project/dcl/config.js
```

---

## 6. 情境範例教學

### 情境 1：建立新 Collection 並設定索引 (DDL)

**檔案**：`20250126000001-create-products.js`

```javascript
export async function up(db, client) {
  // 建立 Collection 並設定 Schema Validation
  await db.createCollection('products', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            description: 'Product name is required'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0,
            description: 'Price must be a positive number'
          },
          category: {
            bsonType: 'string'
          },
          stock: {
            bsonType: 'int',
            minimum: 0
          },
          isActive: {
            bsonType: 'bool'
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'warn'
  });

  // 建立索引
  const collection = db.collection('products');
  
  await collection.createIndex(
    { name: 'text', category: 'text' },
    { name: 'idx_products_text_search' }
  );
  
  await collection.createIndex(
    { category: 1, createdAt: -1 },
    { name: 'idx_products_category_date' }
  );
  
  await collection.createIndex(
    { isActive: 1 },
    { name: 'idx_products_active', sparse: true }
  );
  
  console.log('Created products collection with indexes');
}

export async function down(db, client) {
  await db.collection('products').drop();
  console.log('Dropped products collection');
}
```

### 情境 2：修改現有 Collection - 新增欄位和索引 (DDL)

**檔案**：`20250126000002-add-product-tags.js`

```javascript
export async function up(db, client) {
  const collection = db.collection('products');
  
  // 新增 tags 欄位到所有現有文件
  await collection.updateMany(
    { tags: { $exists: false } },
    { $set: { tags: [], updatedAt: new Date() } }
  );
  
  // 建立 tags 的多鍵索引
  await collection.createIndex(
    { tags: 1 },
    { name: 'idx_products_tags' }
  );
  
  // 更新 Schema Validation（可選）
  await db.command({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: { bsonType: 'string' },
          price: { bsonType: 'decimal', minimum: 0 },
          tags: {
            bsonType: 'array',
            items: { bsonType: 'string' }
          }
        }
      }
    }
  });
  
  console.log('Added tags field and index to products');
}

export async function down(db, client) {
  const collection = db.collection('products');
  
  // 移除索引
  await collection.dropIndex('idx_products_tags');
  
  // 移除欄位
  await collection.updateMany(
    {},
    { $unset: { tags: '' } }
  );
  
  console.log('Removed tags field and index from products');
}
```

### 情境 3：建立應用程式使用者 (DCL)

**檔案**：`R__001_app_users.js`

```javascript
// @description: Application database users
// @type: dcl
// @allow-forbidden: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  const dbName = 'your_database';
  
  // ========================================
  // Read-Only User (for reporting)
  // ========================================
  try {
    const readonlyUsers = await adminDb.command({ 
      usersInfo: { user: 'app_readonly', db: 'admin' } 
    });
    
    if (readonlyUsers.users.length === 0) {
      await adminDb.command({
        createUser: 'app_readonly',
        pwd: process.env.READONLY_PASSWORD || 'readonly_password_here',
        roles: [
          { role: 'read', db: dbName }
        ]
      });
      console.log('[DCL] Created app_readonly user');
    } else {
      await adminDb.command({
        updateUser: 'app_readonly',
        roles: [
          { role: 'read', db: dbName }
        ]
      });
      console.log('[DCL] Updated app_readonly user roles');
    }
  } catch (error) {
    console.error('[DCL] Error managing app_readonly:', error.message);
  }

  // ========================================
  // Read-Write User (for application)
  // ========================================
  try {
    const rwUsers = await adminDb.command({ 
      usersInfo: { user: 'app_readwrite', db: 'admin' } 
    });
    
    if (rwUsers.users.length === 0) {
      await adminDb.command({
        createUser: 'app_readwrite',
        pwd: process.env.READWRITE_PASSWORD || 'readwrite_password_here',
        roles: [
          { role: 'readWrite', db: dbName }
        ]
      });
      console.log('[DCL] Created app_readwrite user');
    } else {
      await adminDb.command({
        updateUser: 'app_readwrite',
        roles: [
          { role: 'readWrite', db: dbName }
        ]
      });
      console.log('[DCL] Updated app_readwrite user roles');
    }
  } catch (error) {
    console.error('[DCL] Error managing app_readwrite:', error.message);
  }
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### 情境 4：建立自定義角色 (DCL)

**檔案**：`R__002_custom_roles.js`

```javascript
// @description: Custom application roles
// @type: dcl
// @allow-forbidden: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  const dbName = 'your_database';
  
  // ========================================
  // Custom Role: Product Manager
  // Can manage products but not orders
  // ========================================
  try {
    const roles = await adminDb.command({ 
      rolesInfo: { role: 'productManager', db: 'admin' } 
    });
    
    const roleDefinition = {
      privileges: [
        {
          resource: { db: dbName, collection: 'products' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'categories' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'orders' },
          actions: ['find']  // Read-only for orders
        }
      ],
      roles: []
    };
    
    if (roles.roles.length === 0) {
      await adminDb.command({
        createRole: 'productManager',
        ...roleDefinition
      });
      console.log('[DCL] Created productManager role');
    } else {
      await adminDb.command({
        updateRole: 'productManager',
        ...roleDefinition
      });
      console.log('[DCL] Updated productManager role');
    }
  } catch (error) {
    console.error('[DCL] Error managing productManager role:', error.message);
  }

  // ========================================
  // Custom Role: Order Manager
  // Can manage orders but only read products
  // ========================================
  try {
    const roles = await adminDb.command({ 
      rolesInfo: { role: 'orderManager', db: 'admin' } 
    });
    
    const roleDefinition = {
      privileges: [
        {
          resource: { db: dbName, collection: 'orders' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'products' },
          actions: ['find']  // Read-only for products
        },
        {
          resource: { db: dbName, collection: 'users' },
          actions: ['find']  // Read-only for users
        }
      ],
      roles: []
    };
    
    if (roles.roles.length === 0) {
      await adminDb.command({
        createRole: 'orderManager',
        ...roleDefinition
      });
      console.log('[DCL] Created orderManager role');
    } else {
      await adminDb.command({
        updateRole: 'orderManager',
        ...roleDefinition
      });
      console.log('[DCL] Updated orderManager role');
    }
  } catch (error) {
    console.error('[DCL] Error managing orderManager role:', error.message);
  }
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### 情境 5：危險操作 - 資料清理 (DCL)

**檔案**：`R__010_data_cleanup.js`

```javascript
// @description: Periodic data cleanup job
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL

export async function up(db, client) {
  console.log('[Cleanup] Starting data cleanup...');
  
  // ========================================
  // 1. Clean up temporary collections
  // ========================================
  // First create the collection so it's not an orphan drop
  await db.createCollection('temp_processing').catch(() => {});
  
  try {
    await db.collection('temp_processing').drop();
    console.log('[Cleanup] Dropped temp_processing collection');
  } catch (error) {
    if (error.code !== 26) { // 26 = NamespaceNotFound
      throw error;
    }
  }

  // ========================================
  // 2. Archive and clean old audit logs (90 days)
  // ========================================
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  
  // Ensure audit_logs_archive exists
  await db.createCollection('audit_logs_archive').catch(() => {});
  
  // Archive old logs
  const oldLogs = await db.collection('audit_logs')
    .find({ createdAt: { $lt: ninetyDaysAgo } })
    .toArray();
  
  if (oldLogs.length > 0) {
    await db.collection('audit_logs_archive').insertMany(oldLogs, {
      ordered: false
    }).catch(() => {}); // Ignore duplicate key errors
    
    // Delete archived logs
    const deleteResult = await db.collection('audit_logs').deleteMany({
      createdAt: { $lt: ninetyDaysAgo }
    });
    
    console.log(`[Cleanup] Archived and deleted ${deleteResult.deletedCount} old audit logs`);
  }

  // ========================================
  // 3. Clean up expired sessions
  // ========================================
  const sessionResult = await db.collection('sessions').deleteMany({
    expiresAt: { $lt: new Date() }
  });
  console.log(`[Cleanup] Deleted ${sessionResult.deletedCount} expired sessions`);

  // ========================================
  // 4. Clean up orphaned files metadata
  // ========================================
  const orphanedFiles = await db.collection('files').deleteMany({
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  });
  console.log(`[Cleanup] Deleted ${orphanedFiles.deletedCount} orphaned file records`);
  
  console.log('[Cleanup] Data cleanup completed');
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### 情境 6：帶有 Sanity Check 的 Migration (DDL)

**檔案**：`20250126000003-add-user-preferences.js`

```javascript
export async function up(db, client) {
  const collection = db.collection('users');
  
  // Pre-check: Ensure users collection exists
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // Pre-check: Ensure preferences field doesn't exist
  const existingWithPrefs = await collection.findOne({ preferences: { $exists: true } });
  if (existingWithPrefs) {
    console.log('Preferences field already exists, skipping update');
    return;
  }
  
  // Migration: Add preferences field
  const result = await collection.updateMany(
    { preferences: { $exists: false } },
    {
      $set: {
        preferences: {
          theme: 'light',
          notifications: true,
          language: 'en'
        },
        updatedAt: new Date()
      }
    }
  );
  
  console.log(`Updated ${result.modifiedCount} users with default preferences`);
  
  // Post-check: Verify all users have preferences
  const usersWithoutPrefs = await collection.countDocuments({ 
    preferences: { $exists: false } 
  });
  
  if (usersWithoutPrefs > 0) {
    throw new Error(`PostCheck failed: ${usersWithoutPrefs} users still without preferences`);
  }
  
  // Create index for preferences queries
  await collection.createIndex(
    { 'preferences.theme': 1 },
    { name: 'idx_users_preferences_theme', sparse: true }
  );
}

export async function down(db, client) {
  const collection = db.collection('users');
  
  // Remove the index
  await collection.dropIndex('idx_users_preferences_theme').catch(() => {});
  
  // Remove the preferences field
  await collection.updateMany(
    {},
    { $unset: { preferences: '' } }
  );
  
  console.log('Removed preferences field from all users');
}
```

### 情境 7：複雜的 Aggregation Pipeline 操作 (DDL)

**檔案**：`20250126000004-create-materialized-view.js`

```javascript
export async function up(db, client) {
  // ========================================
  // Create a materialized view collection
  // for product sales statistics
  // ========================================
  
  // Ensure the view collection exists
  await db.createCollection('product_sales_stats').catch(() => {});
  
  // Create the aggregation pipeline
  const pipeline = [
    {
      $lookup: {
        from: 'products',
        localField: 'productId',
        foreignField: '_id',
        as: 'product'
      }
    },
    {
      $unwind: '$product'
    },
    {
      $group: {
        _id: '$productId',
        productName: { $first: '$product.name' },
        category: { $first: '$product.category' },
        totalSales: { $sum: '$quantity' },
        totalRevenue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: { $multiply: ['$quantity', '$unitPrice'] } },
        lastOrderDate: { $max: '$orderDate' }
      }
    },
    {
      $merge: {
        into: 'product_sales_stats',
        on: '_id',
        whenMatched: 'replace',
        whenNotMatched: 'insert'
      }
    }
  ];
  
  // Run initial aggregation
  await db.collection('order_items').aggregate(pipeline).toArray();
  
  // Create indexes on the stats collection
  const statsCollection = db.collection('product_sales_stats');
  
  await statsCollection.createIndex(
    { totalRevenue: -1 },
    { name: 'idx_stats_revenue' }
  );
  
  await statsCollection.createIndex(
    { category: 1, totalSales: -1 },
    { name: 'idx_stats_category_sales' }
  );
  
  console.log('Created product_sales_stats materialized view');
}

export async function down(db, client) {
  await db.collection('product_sales_stats').drop();
  console.log('Dropped product_sales_stats collection');
}
```

---

## 📝 最佳實踐

1. **DDL 檔案一定要有 down() 函數**，確保可以回滾
2. **DCL 檔案必須是冪等的**，先檢查存在再建立/更新
3. **大 Collection 的索引建立**考慮使用 `{ background: true }` (MongoDB 4.2 之前)
4. **密碼不要硬編碼**，使用環境變數
5. **危險操作要有明確的 Annotation**，說明為什麼需要
6. **使用 try-catch** 處理可能的錯誤
7. **加上 console.log** 記錄執行過程

---

## 🔗 相關文件

- [CLI 使用指南](CLI-USAGE-GUIDE.md)
- [Docker Compose 使用指南](DOCKER-COMPOSE-USER-GUIDE.md)
- [Migration 管理指南](MIGRATION-MANAGEMENT-GUIDE.md)
