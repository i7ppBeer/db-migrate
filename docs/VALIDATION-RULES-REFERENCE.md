# Migration Validation Rules Reference / 遷移驗證規則參考

本文檔列出了 MariaDB 和 MongoDB adapter 的所有驗證規則。

## 目錄

1. [驗證類別總覽](#驗證類別總覽)
2. [MariaDB 驗證規則](#mariadb-驗證規則)
3. [MongoDB 驗證規則](#mongodb-驗證規則)
4. [字串誤判防護](#字串誤判防護)
5. [可疑名稱檢測](#可疑名稱檢測)
6. [效能問題檢測](#效能問題檢測)
7. [測試覆蓋率](#測試覆蓋率)

---

## 驗證類別總覽

| 類別 | 描述 | 嚴重程度 | 可覆寫 |
|------|------|---------|--------|
| **Forbidden** | 絕對禁止的危險操作 | 🔴 Error | `--allow-forbidden` |
| **Dangerous** | 可能危險但可允許的操作 | 🟠 Error | `--allow-dangerous` |
| **Warning** | 警告性提醒 | 🟡 Warning | N/A |
| **Suspicious Name** | 可疑的識別符名稱 | 🟡 Warning | N/A |
| **Performance** | 效能問題警告 | 🔶 Warning | N/A |

---

## MariaDB 驗證規則

### Forbidden Operations / 禁止的操作

| Code | 操作 | Pattern | 描述 |
|------|------|---------|------|
| `DROP_DATABASE` | DROP DATABASE | `\bDROP\s+DATABASE\b` | 刪除整個資料庫 |
| `DROP_SCHEMA` | DROP SCHEMA | `\bDROP\s+SCHEMA\b` | 刪除整個 Schema |
| `TRUNCATE_TABLE` | TRUNCATE TABLE | `\bTRUNCATE\s+TABLE\b` | 清空表格資料 |
| `DROP_USER` | DROP USER | `\bDROP\s+USER\b` | 刪除使用者 |
| `GRANT` | GRANT | `\bGRANT\s+...` | 授予權限（需 DCL migration） |
| `REVOKE` | REVOKE | `\bREVOKE\s+...` | 撤銷權限（需 DCL migration） |
| `CREATE_USER` | CREATE USER | `\bCREATE\s+USER\b` | 建立使用者（需 DCL migration） |
| `SHUTDOWN` | SHUTDOWN | `\bSHUTDOWN\s*(?:;|$)` | 關閉資料庫伺服器 |
| `FLUSH_PRIVILEGES` | FLUSH PRIVILEGES | `\bFLUSH\s+PRIVILEGES\b` | 重載權限表 |
| `LOAD_DATA` | LOAD DATA | `\bLOAD\s+DATA\b` | 從檔案載入資料 |
| `INTO_OUTFILE` | INTO OUTFILE | `\bINTO\s+OUTFILE\b` | 輸出到檔案 |

### Dangerous Operations / 危險操作

| Code | 操作 | Pattern | 描述 |
|------|------|---------|------|
| `DROP_TABLE` | DROP TABLE | `\bDROP\s+TABLE\b` | 刪除表格 |
| `TRUNCATE_TABLE` | TRUNCATE TABLE | `\bTRUNCATE\s+TABLE\b` | 清空表格資料 |
| `DROP_INDEX` | DROP INDEX | `\bDROP\s+INDEX\b` | 刪除索引 |
| `DROP_VIEW` | DROP VIEW | `\bDROP\s+VIEW\b` | 刪除視圖 |
| `DROP_PROCEDURE` | DROP PROCEDURE | `\bDROP\s+PROCEDURE\b` | 刪除儲存過程 |
| `DROP_FUNCTION` | DROP FUNCTION | `\bDROP\s+FUNCTION\b` | 刪除函數 |
| `DROP_TRIGGER` | DROP TRIGGER | `\bDROP\s+TRIGGER\b` | 刪除觸發器 |
| `ALTER_TABLE` | ALTER TABLE | `\bALTER\s+TABLE\b` | 修改表格結構 |
| `RENAME_TABLE` | RENAME TABLE | `\bRENAME\s+TABLE\b` | 重命名表格 |
| `DELETE_FROM` | DELETE FROM | `\bDELETE\s+FROM\b` | 刪除資料 |
| `UPDATE_WITHOUT_WHERE` | UPDATE without WHERE | 見代碼 | 無 WHERE 的更新 |
| `DELETE_WITHOUT_WHERE` | DELETE without WHERE | 見代碼 | 無 WHERE 的刪除 |

### Warning Operations / 警告操作

| 操作 | Pattern | 描述 |
|------|---------|------|
| Large Data Operations | `\bUPDATE\b.*\bSET\b` | 大量資料更新 |
| REPLACE INTO | `\bREPLACE\s+INTO\b` | 可能刪除並重新插入 |

### Performance Checks / 效能檢測

| Code | 檢測項目 | 閾值 | 描述 |
|------|----------|------|------|
| `MIGRATION_TOO_LONG` | Migration 長度 | 50,000 chars | 單一 migration 過長 |
| `QUERY_TOO_LONG` | 單一查詢長度 | 5,000 chars | 單一 SQL 語句過長 |
| `TOO_MANY_INDEXES` | 索引數量 | 5 per migration | 同時建立過多索引 |
| `MULTIPLE_INDEXES_SAME_TABLE` | 同表多索引 | 2+ | 同一表格建多個索引 |
| `TOO_MANY_JOINS` | JOIN 數量 | 5 per query | 單一查詢過多 JOIN |
| `TOO_MANY_SUBQUERIES` | 子查詢數量 | 3 per query | 單一查詢過多子查詢 |
| `TOO_MANY_STATEMENTS` | 語句數量 | 50 per migration | 單一 migration 過多語句 |
| `UNION_QUERY_COUNT` | UNION 數量 | 5 per query | 過多 UNION |
| `CASE_WHEN_COUNT` | CASE WHEN 數量 | 10 per query | 過多 CASE WHEN |
| `FULLTEXT_INDEX` | FULLTEXT 索引 | - | 全文索引影響效能 |
| `SPATIAL_INDEX` | SPATIAL 索引 | - | 空間索引影響效能 |

---

## MongoDB 驗證規則

### Forbidden Operations / 禁止的操作

| Code | 操作 | Pattern | 描述 |
|------|------|---------|------|
| `DROP_DATABASE` | dropDatabase | `\.dropDatabase\s*\(` | 刪除整個資料庫 |
| `SHUTDOWN` | db.shutdownServer | `\bshutdownServer\s*\(` | 關閉伺服器 |
| `CREATE_USER` | createUser | `\.createUser\s*\(` | 建立使用者 |
| `DROP_USER` | dropUser | `\.dropUser\s*\(` | 刪除使用者 |
| `UPDATE_USER` | updateUser | `\.updateUser\s*\(` | 更新使用者 |
| `GRANT_ROLES` | grantRolesToUser | `\.grantRolesToUser\s*\(` | 授予角色 |
| `REVOKE_ROLES` | revokeRolesFromUser | `\.revokeRolesFromUser\s*\(` | 撤銷角色 |
| `CREATE_ROLE` | createRole | `\.createRole\s*\(` | 建立角色 |
| `DROP_ROLE` | dropRole | `\.dropRole\s*\(` | 刪除角色 |

### Dangerous Operations / 危險操作

| Code | 操作 | Pattern | 描述 |
|------|------|---------|------|
| `DROP_COLLECTION` | drop() | `\.drop\s*\(` | 刪除 Collection |
| `DELETE_MANY` | deleteMany({}) | `\.deleteMany\s*\(\s*{}\s*\)` | 刪除所有文件 |
| `UPDATE_MANY` | updateMany({}) | `\.updateMany\s*\(\s*{}\s*,` | 更新所有文件 |
| `DROP_INDEX` | dropIndex | `\.dropIndex\s*\(` | 刪除索引 |
| `DROP_INDEXES` | dropIndexes | `\.dropIndexes\s*\(` | 刪除所有索引 |
| `RENAME_COLLECTION` | renameCollection | `\.renameCollection\s*\(` | 重命名 Collection |
| `REMOVE_DEPRECATED` | remove() | `\.remove\s*\(` | 使用已棄用方法 |

### Warning Operations / 警告操作

| 操作 | Pattern | 描述 |
|------|---------|------|
| Large updateMany | `\.updateMany\s*\(` | 大量更新操作 |
| replaceOne | `\.replaceOne\s*\(` | 整個文件替換 |
| findAndModify | `\.findAndModify\s*\(` | 原子修改操作 |
| Compact | `\.runCommand\s*\(\s*['"]\{?\s*compact` | 壓縮 Collection |

### Performance Checks / 效能檢測

| Code | 檢測項目 | 閾值 | 描述 |
|------|----------|------|------|
| `MIGRATION_TOO_LONG` | Migration 長度 | 50,000 chars | 單一 migration 過長 |
| `TOO_MANY_INDEXES` | 索引數量 | 5 per migration | 同時建立過多索引 |
| `MULTIPLE_INDEXES_SAME_COLLECTION` | 同 Collection 多索引 | 2+ | 同一 Collection 建多個索引 |
| `TOO_MANY_BULK_OPS` | Bulk 操作數量 | 10 per migration | 過多 bulk 操作 |
| `TOO_MANY_LOOKUPS` | $lookup stages | 3 per aggregate | 過多 $lookup 查詢 |
| `COMPLEX_AGGREGATE` | Pipeline stages | 10 per aggregate | 過於複雜的聚合管道 |
| `UNBOUNDED_FIND` | find() without limit | - | 無限制的 find 查詢 |
| `SORT_WITHOUT_LIMIT` | sort() without limit | - | 排序沒有限制 |

---

## 字串誤判防護

### 原理

為防止字串內容（如日誌訊息、資料值）中的危險關鍵字觸發誤報，正規化過程會：

1. **字串值替換**：將所有字串常量替換為 `'__STRING__'` 佔位符
2. **註解移除**：移除所有單行和多行註解
3. **空白正規化**：將多個空白壓縮為單一空格

### 範例

```sql
-- MariaDB 範例
INSERT INTO log VALUES ('User tried to DROP DATABASE'); -- 不會觸發
DROP DATABASE production; -- 會觸發

-- 正規化前: INSERT INTO log VALUES ('User tried to DROP DATABASE');
-- 正規化後: INSERT INTO log VALUES ( '__STRING__' );
```

```javascript
// MongoDB 範例
console.log('Warning: dropDatabase is forbidden'); // 不會觸發
db.dropDatabase(); // 會觸發

// 正規化前: console.log('Warning: dropDatabase is forbidden');
// 正規化後: console.log('__STRING__');
```

### 測試案例

| Adapter | 測試檔案 | 測試數量 |
|---------|----------|----------|
| MariaDB | `normalize-pattern.test.js` | 7 tests |
| MongoDB | `mongodb-adapter.test.js` | 7 tests |

---

## 可疑名稱檢測

### 原理

檢測識別符（表格名、Collection 名、變數名、索引名）是否包含危險關鍵字。這些命名可能導致：
- 維護混淆
- 誤判風險
- 安全審計困難

### 檢測關鍵字

| 關鍵字 | 變體 |
|--------|------|
| `dropdatabase` | `drop_database`, `dropdb` |
| `deleteall` | `delete_all` |
| `removeall` | `remove_all` |
| `shutdown` | - |
| `createuser` | `create_user` |
| `dropuser` | `drop_user` |
| `grantrole` | `grant_role` |
| `revokerole` | `revoke_role` |

### 範例

```sql
-- MariaDB 會發出警告
CREATE TABLE drop_database_log (...);  -- ⚠️ SUSPICIOUS NAME
CREATE INDEX idx_shutdown_status ON events(...);  -- ⚠️ SUSPICIOUS NAME
```

```javascript
// MongoDB 會發出警告
await db.createCollection('deleteall_backup');  // ⚠️ SUSPICIOUS NAME
const dropDatabaseHelper = () => {};  // ⚠️ SUSPICIOUS NAME
```

### 測試案例

| Adapter | 測試檔案 | 測試數量 |
|---------|----------|----------|
| MariaDB | `normalize-pattern.test.js` | 12 tests |
| MongoDB | `mongodb-adapter.test.js` | 6 tests |

---

## 效能問題檢測

### MariaDB 效能閾值

| 項目 | 預設值 | 可配置 |
|------|--------|--------|
| `maxQueryLength` | 5,000 | ✅ |
| `maxTotalLength` | 50,000 | ✅ |
| `maxIndexesPerMigration` | 5 | ✅ |
| `maxJoinsPerQuery` | 5 | ✅ |
| `maxSubqueries` | 3 | ✅ |
| `maxStatementsPerMigration` | 50 | ✅ |

### MongoDB 效能閾值

| 項目 | 預設值 | 可配置 |
|------|--------|--------|
| `maxQueryLength` | 5,000 | ✅ |
| `maxTotalLength` | 50,000 | ✅ |
| `maxIndexesPerMigration` | 5 | ✅ |
| `maxBulkOpsPerMigration` | 10 | ✅ |
| `maxStatementsPerMigration` | 50 | ✅ |
| `maxLookupStages` | 3 | ✅ |
| `maxPipelineStages` | 10 | ✅ |

### 測試案例

| Adapter | 測試檔案 | 測試數量 |
|---------|----------|----------|
| MariaDB | `normalize-pattern.test.js` | 26 tests |
| MongoDB | `mongodb-adapter.test.js` | 9 tests |

---

## 測試覆蓋率

### 總測試統計

| 測試類別 | 測試數量 |
|----------|----------|
| **CLI Tests** | 10 |
| **DCL Idempotent Checker** | 14 |
| **MariaDB Adapter** | 14 |
| **MongoDB Adapter** | 35 |
| **Normalize Pattern (MariaDB)** | 77 |
| **Normalize Pattern (MongoDB)** | 22 |
| **Cross-Adapter Edge Cases** | 4 |
| **Repeatable Runner** | 11 |
| **Sanity Checker** | 25 |
| **Security Edge Cases** | 54 |
| **總計** | **266** |

### 按功能分類

| 功能 | MariaDB Tests | MongoDB Tests |
|------|---------------|---------------|
| 基本正規化 | 7 | 5 |
| 字串誤判防護 | 7 | 7 |
| 可疑名稱檢測 | 12 | 6 |
| 效能問題檢測 | 26 | 9 |
| Pattern Matching | 25 | 15 |
| Structural Checks | - | 8 |

---

## 使用方式

### CLI 範例

```bash
# 執行驗證
node src/cli.js -c ./databases/mariadb/test-success/ddl/config.js validate

# 允許危險操作
node src/cli.js -c ./databases/mariadb/test-success/ddl/config.js validate --allow-dangerous

# 允許特定 code
node src/cli.js -c ./databases/mariadb/test-success/ddl/config.js validate --allow DROP_TABLE,ALTER_TABLE
```

### 程式化使用

```javascript
import { MariaDBAdapter } from './src/adapters/mariadb-adapter.js';

const adapter = new MariaDBAdapter(config);
const result = adapter.validateContent(content, 'migration.sql', {
  allowDangerous: false,
  allowForbidden: false,
  allowedCodes: ['ALTER_TABLE']
});

console.log(result.valid);              // boolean
console.log(result.errors);             // 所有錯誤
console.log(result.warnings);           // 所有警告
console.log(result.suspiciousNames);    // 可疑名稱
console.log(result.performanceIssues);  // 效能問題
console.log(result.performanceMetrics); // 效能指標
```

---

## 版本歷史

| 版本 | 日期 | 變更 |
|------|------|------|
| 2.1.0 | 2025-01 | 新增字串誤判防護、可疑名稱檢測、效能檢測 |
| 2.0.0 | 2025-01 | 重構驗證系統，支援 MariaDB 和 MongoDB |
| 1.0.0 | 2024 | 初始版本 |
