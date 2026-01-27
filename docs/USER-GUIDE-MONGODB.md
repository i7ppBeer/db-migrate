# MongoDB DDL/DCL 編寫指南

> 本指南說明如何為 MongoDB 編寫 DDL (資料定義語言) 和 DCL (資料控制語言) Migration 檔案。

---

## 📋 目錄

1. [檔案類型說明](#1-檔案類型說明)
2. [Versioned vs Repeatable 語法對照](#2-versioned-vs-repeatable-語法對照)
3. [Migration 檔案結構詳解](#3-migration-檔案結構詳解)
4. [危險指令列表](#4-危險指令列表)
5. [如何允許危險指令](#5-如何允許危險指令)
6. [Sanity Check 機制](#6-sanity-check-機制)
7. [Docker 環境設定與 CLI 使用](#7-docker-環境設定與-cli-使用)
8. [情境範例教學](#8-情境範例教學)

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

## 3. Migration 檔案結構詳解

### 3.1 完整檔案結構圖

#### MongoDB Migration 檔案結構 (.js)

**📄 ANNOTATION 區塊** *(可選)*
> 使用 `//` 註解的 metadata 設定

```javascript
// @description: 說明這個 migration 的用途
// @allow-dangerous: true
```

---

**🔵 UP 函數** *(必要)*
> `export async function up(db, client) { ... }`

包含以下子區塊：

| 區塊 | 寫法 | 必要性 | 說明 |
|------|------|--------|------|
| 🟡 **PreCheck** | `// ══ PreCheck ══` + throw Error | 可選 | 執行前的狀態檢查 |
| 🟢 **主要邏輯** | `// ══ Main Migration ══` | 必要 | 實際要執行的 DDL 操作 |
| 🟡 **PostCheck** | `// ══ PostCheck ══` + throw Error | 可選 | 執行後的結果驗證 |

**PreCheck 範例：**
```javascript
// ══ PreCheck ══
const exists = await db.listCollections({name: 'users'}).toArray();
if (exists.length === 0) throw new Error('PreCheck failed: users collection not found');
```

**主要邏輯範例：**
```javascript
// ══ Main Migration ══
await db.collection('users').createIndex({email: 1});
await db.collection('users').updateMany(...);
```

**PostCheck 範例：**
```javascript
// ══ PostCheck ══
const indexes = await db.collection('users').indexes();
if (!indexes.find(i => i.name === 'idx_email')) {
  throw new Error('PostCheck failed: index not created');
}
```

---

**🔴 DOWN 函數** *(建議有)*
> `export async function down(db, client) { ... }`

```javascript
await db.collection('users').dropIndex('idx_email');
await db.collection('users').drop();
```

---

#### 完整範例結構

```javascript
// @description: ...              // ANNOTATION 區塊
// @allow-dangerous: true

export async function up(db, client) {   // UP 函數開始
  
  // ══ PreCheck ══               // PreCheck 開始
  const exists = await db.listCollections({name: 'users'}).toArray();
  if (exists.length === 0) throw new Error('PreCheck failed');
  
  // ══ Main Migration ══         // 主要邏輯
  await db.createCollection('orders');
  await db.collection('orders').createIndex({userId: 1});
  
  // ══ PostCheck ══              // PostCheck 開始
  const indexes = await db.collection('orders').indexes();
  if (!indexes.find(i => i.name === 'userId_1')) {
    throw new Error('PostCheck failed');
  }
}

export async function down(db, client) { // DOWN 函數開始
  await db.collection('orders').drop();
}
```

### 3.2 各區塊說明

| 區塊 | 寫法 | 必要性 | 用途 |
|------|------|--------|------|
| **up()** | `export async function up(db, client)` | ✅ 必要 | 定義「正向遷移」邏輯 |
| **down()** | `export async function down(db, client)` | ⚠️ 建議 | 定義「回滾」邏輯 |
| **PreCheck** | 在 up() 開頭的檢查程式碼 | ❌ 可選 | 執行前的狀態檢查 |
| **PostCheck** | 在 up() 結尾的驗證程式碼 | ❌ 可選 | 執行後的結果驗證 |

### 3.3 執行流程

![MongoDB 執行流程](images/mongodb-execution-flow.drawio.svg)

> 💡 **提示**：此圖表可使用 VS Code 的 [Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) 擴充套件直接編輯。

### 3.4 基本範例 (只有 up/down)

```javascript
export async function up(db, client) {
  // 建立 Collection
  await db.createCollection('users');
  
  // 建立索引
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, name: 'uk_users_email' }
  );
  
  await db.collection('users').createIndex(
    { createdAt: -1 },
    { name: 'idx_users_createdAt' }
  );
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### 3.5 完整範例 (含 PreCheck/PostCheck)

```javascript
/**
 * 新增 phone 欄位到所有 users
 * @description: Add phone field to users collection
 * @allow-dangerous: true
 */

export async function up(db, client) {
  const collection = db.collection('users');
  
  // ═══════════════════════════════════════════════════════════════
  // PreCheck: 前置檢查
  // ═══════════════════════════════════════════════════════════════
  
  // 確認 users collection 存在
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // 確認尚未有 phone 欄位（避免重複執行）
  const existingDoc = await collection.findOne({ phone: { $exists: true } });
  if (existingDoc) {
    console.log('phone field already exists, skipping migration');
    return; // 冪等性：已存在則跳過
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Main Migration: 主要邏輯
  // ═══════════════════════════════════════════════════════════════
  
  // 為所有文件新增 phone 欄位
  const result = await collection.updateMany(
    { phone: { $exists: false } },
    { $set: { phone: null, updatedAt: new Date() } }
  );
  console.log(`Updated ${result.modifiedCount} documents`);
  
  // 建立索引
  await collection.createIndex(
    { phone: 1 },
    { name: 'idx_users_phone', sparse: true }
  );
  
  // ═══════════════════════════════════════════════════════════════
  // PostCheck: 後置驗證
  // ═══════════════════════════════════════════════════════════════
  
  // 確認所有文件都有 phone 欄位
  const missingPhone = await collection.countDocuments({ phone: { $exists: false } });
  if (missingPhone > 0) {
    throw new Error(`PostCheck failed: ${missingPhone} documents still missing phone field`);
  }
  
  // 確認索引已建立
  const indexes = await collection.indexes();
  const phoneIndex = indexes.find(idx => idx.name === 'idx_users_phone');
  if (!phoneIndex) {
    throw new Error('PostCheck failed: idx_users_phone index not created');
  }
  
  console.log('Migration completed successfully');
}

export async function down(db, client) {
  const collection = db.collection('users');
  
  // 刪除索引
  await collection.dropIndex('idx_users_phone').catch(() => {});
  
  // 移除 phone 欄位
  await collection.updateMany(
    {},
    { $unset: { phone: '' } }
  );
}
```

### 3.6 Schema Validation 範例

```javascript
/**
 * 設定 products collection 的 Schema Validation
 */

export async function up(db, client) {
  // ═══════════════════════════════════════════════════════════════
  // PreCheck
  // ═══════════════════════════════════════════════════════════════
  
  // 確認 collection 存在
  const collections = await db.listCollections({ name: 'products' }).toArray();
  if (collections.length === 0) {
    // 不存在則建立
    await db.createCollection('products');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Main Migration: 套用 Schema Validation
  // ═══════════════════════════════════════════════════════════════
  
  await db.command({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            minLength: 1,
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
          }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'warn'
  });
  
  // ═══════════════════════════════════════════════════════════════
  // PostCheck
  // ═══════════════════════════════════════════════════════════════
  
  const collInfo = await db.listCollections({ name: 'products' }).toArray();
  if (!collInfo[0]?.options?.validator) {
    throw new Error('PostCheck failed: Schema validation not applied');
  }
}

export async function down(db, client) {
  // 移除 Schema Validation
  await db.command({
    collMod: 'products',
    validator: {},
    validationLevel: 'off'
  });
}
```

### 3.7 DCL (Repeatable) 範例

```javascript
/**
 * 建立應用程式使用者
 * @description: Create application database users
 * @type: dcl
 * @allow-dangerous: true
 */

// 注意：DCL 檔案也需要 up() 和 down() 函數
// 但 down() 通常只記錄日誌，不實際回滾

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // ═══════════════════════════════════════════════════════════════
  // 建立 app_user (讀寫權限)
  // ═══════════════════════════════════════════════════════════════
  
  try {
    // 嘗試建立使用者
    await adminDb.command({
      createUser: 'app_user',
      pwd: 'secure_password_here',
      roles: [
        { role: 'readWrite', db: 'mydb' }
      ]
    });
    console.log('Created user: app_user');
  } catch (error) {
    if (error.code === 51003) {
      // 使用者已存在，更新角色
      await adminDb.command({
        updateUser: 'app_user',
        roles: [
          { role: 'readWrite', db: 'mydb' }
        ]
      });
      console.log('Updated user: app_user');
    } else {
      throw error;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // 建立 readonly_user (唯讀權限)
  // ═══════════════════════════════════════════════════════════════
  
  try {
    await adminDb.command({
      createUser: 'readonly_user',
      pwd: 'readonly_password_here',
      roles: [
        { role: 'read', db: 'mydb' }
      ]
    });
    console.log('Created user: readonly_user');
  } catch (error) {
    if (error.code === 51003) {
      await adminDb.command({
        updateUser: 'readonly_user',
        roles: [
          { role: 'read', db: 'mydb' }
        ]
      });
      console.log('Updated user: readonly_user');
    } else {
      throw error;
    }
  }
}

export async function down(db, client) {
  // DCL 通常不回滾
  console.log('DCL migrations typically do not support rollback');
  console.log('To remove users, create a new migration');
}
```

### 3.8 關鍵規則總結

| 規則 | 說明 |
|------|------|
| `export async function up(db, client)` | **必須**有，定義正向遷移邏輯 |
| `export async function down(db, client)` | **建議**有，定義回滾邏輯 |
| PreCheck | 在 up() **開頭**寫檢查，失敗時 `throw new Error()` |
| PostCheck | 在 up() **結尾**寫驗證，失敗時 `throw new Error()` |
| 冪等性 | 檢查是否已執行過，若是則 `return` 跳過 |
| 參數 `db` | 當前資料庫實例 |
| 參數 `client` | MongoDB Client，可用於存取其他資料庫如 `client.db('admin')` |
| DCL 檔案 | 也需要 up/down 函數，但 down 通常只是記錄日誌 |

---

## 4. 危險指令列表

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

## 5. 如何允許危險指令

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

## 6. Sanity Check 機制

Sanity Check 提供 **Pre-Check（前置檢查）** 和 **Post-Check（後置檢查）** 機制，確保 migration 執行前後的狀態正確，並支援**自動回滾**。

### 6.1 Sanity Check 程式碼結構

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check: 前置檢查
  // ═══════════════════════════════════════════════════════
  
  // 檢查 Collection 是否存在
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // 檢查欄位是否已存在（避免重複執行）
  const existingDoc = await db.collection('users').findOne({ newField: { $exists: true } });
  if (existingDoc) {
    console.log('Field already exists, skipping migration');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: 執行主要遷移
  // ═══════════════════════════════════════════════════════
  
  await db.collection('users').updateMany(
    { newField: { $exists: false } },
    { $set: { newField: 'defaultValue' } }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: 後置檢查
  // ═══════════════════════════════════════════════════════
  
  // 確認所有文件都有新欄位
  const missingCount = await db.collection('users').countDocuments({ 
    newField: { $exists: false } 
  });
  
  if (missingCount > 0) {
    throw new Error(`PostCheck failed: ${missingCount} documents still missing newField`);
  }
}

export async function down(db, client) {
  await db.collection('users').updateMany(
    {},
    { $unset: { newField: '' } }
  );
}
```

### 6.2 執行流程

```
┌─────────────────┐
│   Pre-Check     │ ── 失敗 ──→ 拋出 Error，停止執行
└────────┬────────┘
         │ 成功
         ▼
┌─────────────────┐
│ Execute Migration│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Post-Check    │ ── 失敗 ──→ 拋出 Error（可在外層捕獲並回滾）
└────────┬────────┘
         │ 成功
         ▼
      完成 ✅
```

### 6.3 Sanity Check 情境範例

#### 範例 1：新增欄位前確認 Collection 存在

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check
  // ═══════════════════════════════════════════════════════
  const collections = await db.listCollections({ name: 'products' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: products collection does not exist');
  }
  
  // 確認 tags 欄位不存在
  const existingWithTags = await db.collection('products').findOne({ 
    tags: { $exists: true } 
  });
  if (existingWithTags) {
    console.log('tags field already exists, skipping');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration
  // ═══════════════════════════════════════════════════════
  const result = await db.collection('products').updateMany(
    { tags: { $exists: false } },
    { $set: { tags: [], updatedAt: new Date() } }
  );
  console.log(`Updated ${result.modifiedCount} products`);
  
  // 建立索引
  await db.collection('products').createIndex(
    { tags: 1 },
    { name: 'idx_products_tags' }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check
  // ═══════════════════════════════════════════════════════
  const missingTags = await db.collection('products').countDocuments({ 
    tags: { $exists: false } 
  });
  if (missingTags > 0) {
    throw new Error(`PostCheck failed: ${missingTags} products still missing tags`);
  }
  
  // 確認索引存在
  const indexes = await db.collection('products').indexes();
  const hasIndex = indexes.some(idx => idx.name === 'idx_products_tags');
  if (!hasIndex) {
    throw new Error('PostCheck failed: idx_products_tags index not created');
  }
}

export async function down(db, client) {
  await db.collection('products').dropIndex('idx_products_tags').catch(() => {});
  await db.collection('products').updateMany({}, { $unset: { tags: '' } });
}
```

#### 範例 2：建立索引前確認無重複值

```javascript
export async function up(db, client) {
  const collection = db.collection('users');
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check: 確認沒有重複的 email
  // ═══════════════════════════════════════════════════════
  const duplicates = await collection.aggregate([
    { $group: { _id: '$email', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 }
  ]).toArray();
  
  if (duplicates.length > 0) {
    const dupEmails = duplicates.map(d => d._id).join(', ');
    throw new Error(`PreCheck failed: Duplicate emails found: ${dupEmails}`);
  }
  
  // 確認沒有 null email
  const nullEmails = await collection.countDocuments({ 
    $or: [{ email: null }, { email: '' }] 
  });
  if (nullEmails > 0) {
    throw new Error(`PreCheck failed: ${nullEmails} users have null/empty email`);
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: 建立唯一索引
  // ═══════════════════════════════════════════════════════
  await collection.createIndex(
    { email: 1 },
    { unique: true, name: 'idx_users_email_unique' }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: 確認索引已建立
  // ═══════════════════════════════════════════════════════
  const indexes = await collection.indexes();
  const uniqueIndex = indexes.find(idx => idx.name === 'idx_users_email_unique');
  
  if (!uniqueIndex) {
    throw new Error('PostCheck failed: Unique index not created');
  }
  
  if (!uniqueIndex.unique) {
    throw new Error('PostCheck failed: Index is not unique');
  }
  
  console.log('Successfully created unique email index');
}

export async function down(db, client) {
  await db.collection('users').dropIndex('idx_users_email_unique');
}
```

#### 範例 3：資料遷移確認完整性

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check: 確認來源和目標都準備好
  // ═══════════════════════════════════════════════════════
  
  // 確認來源 Collection 有資料
  const sourceCount = await db.collection('old_orders').countDocuments();
  if (sourceCount === 0) {
    console.log('No data to migrate, skipping');
    return;
  }
  
  // 確認目標 Collection 存在
  const collections = await db.listCollections({ name: 'new_orders' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: new_orders collection does not exist');
  }
  
  // 記錄遷移前的數量
  const beforeTargetCount = await db.collection('new_orders').countDocuments();
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: 使用 aggregation pipeline 遷移資料
  // ═══════════════════════════════════════════════════════
  const pipeline = [
    { $match: { migrated: { $ne: true } } },
    {
      $project: {
        orderId: '$_id',
        customerId: '$customer_id',
        items: '$order_items',
        totalAmount: '$total',
        status: '$order_status',
        createdAt: '$created_at',
        migratedAt: new Date()
      }
    },
    {
      $merge: {
        into: 'new_orders',
        on: 'orderId',
        whenMatched: 'keepExisting',
        whenNotMatched: 'insert'
      }
    }
  ];
  
  await db.collection('old_orders').aggregate(pipeline).toArray();
  
  // 標記已遷移
  await db.collection('old_orders').updateMany(
    { migrated: { $ne: true } },
    { $set: { migrated: true, migratedAt: new Date() } }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: 確認遷移完整性
  // ═══════════════════════════════════════════════════════
  
  // 確認所有來源資料都已標記遷移
  const unmigrated = await db.collection('old_orders').countDocuments({ 
    migrated: { $ne: true } 
  });
  if (unmigrated > 0) {
    throw new Error(`PostCheck failed: ${unmigrated} orders not migrated`);
  }
  
  // 確認目標資料增加了
  const afterTargetCount = await db.collection('new_orders').countDocuments();
  console.log(`Migrated ${afterTargetCount - beforeTargetCount} orders`);
  
  if (afterTargetCount < beforeTargetCount) {
    throw new Error('PostCheck failed: Target collection count decreased!');
  }
}

export async function down(db, client) {
  // 刪除遷移的資料
  await db.collection('new_orders').deleteMany({ migratedAt: { $exists: true } });
  
  // 重設遷移標記
  await db.collection('old_orders').updateMany(
    { migrated: true },
    { $unset: { migrated: '', migratedAt: '' } }
  );
}
```

#### 範例 4：Schema Validation 變更前確認資料相容

```javascript
export async function up(db, client) {
  const collectionName = 'products';
  const collection = db.collection(collectionName);
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check: 確認現有資料符合新的 Schema
  // ═══════════════════════════════════════════════════════
  
  // 檢查是否有缺少必填欄位的文件
  const missingName = await collection.countDocuments({ 
    $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] 
  });
  if (missingName > 0) {
    throw new Error(`PreCheck failed: ${missingName} products missing required 'name' field`);
  }
  
  // 檢查價格是否都是正數
  const invalidPrice = await collection.countDocuments({ 
    $or: [
      { price: { $exists: false } },
      { price: { $lt: 0 } },
      { price: { $type: 'string' } }
    ] 
  });
  if (invalidPrice > 0) {
    throw new Error(`PreCheck failed: ${invalidPrice} products have invalid price`);
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: 套用嚴格的 Schema Validation
  // ═══════════════════════════════════════════════════════
  await db.command({
    collMod: collectionName,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            minLength: 1,
            description: 'Product name is required'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0,
            description: 'Price must be a positive decimal'
          },
          stock: {
            bsonType: 'int',
            minimum: 0
          }
        }
      }
    },
    validationLevel: 'strict',
    validationAction: 'error'
  });
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: 確認 Schema Validation 已套用
  // ═══════════════════════════════════════════════════════
  const collectionInfo = await db.listCollections({ name: collectionName }).toArray();
  const options = collectionInfo[0]?.options;
  
  if (!options?.validator) {
    throw new Error('PostCheck failed: Schema validation not applied');
  }
  
  if (options?.validationLevel !== 'strict') {
    throw new Error('PostCheck failed: validationLevel is not strict');
  }
  
  console.log('Schema validation applied successfully');
}

export async function down(db, client) {
  // 移除 Schema Validation
  await db.command({
    collMod: 'products',
    validator: {},
    validationLevel: 'off'
  });
}
```

#### 範例 5：建立 TTL 索引前確認欄位存在

```javascript
export async function up(db, client) {
  const collection = db.collection('sessions');
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check
  // ═══════════════════════════════════════════════════════
  
  // 確認 Collection 存在
  const collections = await db.listCollections({ name: 'sessions' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: sessions collection does not exist');
  }
  
  // 確認 expiresAt 欄位存在且是日期類型
  const sampleDoc = await collection.findOne({ expiresAt: { $exists: true } });
  if (!sampleDoc) {
    throw new Error('PreCheck failed: No documents with expiresAt field found');
  }
  
  if (!(sampleDoc.expiresAt instanceof Date)) {
    throw new Error('PreCheck failed: expiresAt is not a Date type');
  }
  
  // 確認沒有已存在的 TTL 索引
  const indexes = await collection.indexes();
  const existingTTL = indexes.find(idx => idx.expireAfterSeconds !== undefined);
  if (existingTTL) {
    console.log('TTL index already exists, skipping');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration
  // ═══════════════════════════════════════════════════════
  await collection.createIndex(
    { expiresAt: 1 },
    { 
      name: 'idx_sessions_ttl',
      expireAfterSeconds: 0  // 在 expiresAt 指定的時間過期
    }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check
  // ═══════════════════════════════════════════════════════
  const newIndexes = await collection.indexes();
  const ttlIndex = newIndexes.find(idx => idx.name === 'idx_sessions_ttl');
  
  if (!ttlIndex) {
    throw new Error('PostCheck failed: TTL index not created');
  }
  
  if (ttlIndex.expireAfterSeconds !== 0) {
    throw new Error('PostCheck failed: TTL index has wrong expireAfterSeconds value');
  }
  
  console.log('TTL index created successfully');
}

export async function down(db, client) {
  await db.collection('sessions').dropIndex('idx_sessions_ttl');
}
```

---

## 7. Docker 環境設定與 CLI 使用

### 7.1 取得 Docker Image

```bash
# 方法一：從 Registry 拉取（如果已發布）
docker pull your-registry/ddl-migrate:latest

# 方法二：本地建置
git clone https://github.com/your-org/ddl-migrate.git
cd ddl-migrate
docker compose build migrate
```

### 7.2 本地環境準備

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

### 7.3 CLI 命令大全

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

## 8. 情境範例教學

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
