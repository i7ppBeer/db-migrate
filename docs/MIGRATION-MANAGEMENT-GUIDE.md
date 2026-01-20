# 📋 SQL/MongoDB 資料庫遷移管理系統企劃案

> 本文件說明如何使用 Migration 工具管理 DDL（Data Definition Language）和 DCL（Data Control Language），包含驗證規則、冪等性設計、危險指令檢查與 Sanity Check。

---

## 目錄

1. [業界痛點分析](#一業界痛點分析)
2. [Migration 工具核心功能解析](#二migration-工具核心功能解析)
3. [Up-Down-Up 三階段檢測機制](#三up-down-up-三階段檢測機制)
4. [危險操作放行機制](#四危險操作放行機制)
5. [DDL 新增欄位 Sanity Check 與自動回滾](#五ddl-新增欄位-sanity-check-與自動回滾)
6. [DDL vs DCL 分離管理策略](#六ddl-vs-dcl-分離管理策略)
7. [DCL 管理規則（平台團隊）](#七dcl-管理規則平台團隊)
8. [DDL 管理規則（開發團隊）](#八ddl-管理規則開發團隊)
9. [完整管理規則總覽](#九完整管理規則總覽)
10. [使用情境指南](#十使用情境指南)
11. [CI/CD Pipeline 整合](#十一cicd-pipeline-整合)

---

## 一、業界痛點分析

### 為什麼需要這套系統？

在沒有完善的資料庫遷移管理機制下，團隊經常遇到以下問題：

### 1.1 生產事故類痛點

```
┌─────────────────────────────────────────────────────────────────────────┐
│  🔥 真實案例：某電商平台大促期間執行遷移，導致 4 小時停機               │
├─────────────────────────────────────────────────────────────────────────┤
│  原因：在千萬級訂單表上執行 CREATE INDEX（非 CONCURRENTLY）              │
│  影響：全表鎖定，所有訂單查詢超時，損失預估 2000 萬營收                   │
│  根因：缺乏危險操作檢測機制                                              │
└─────────────────────────────────────────────────────────────────────────┘
```

| 痛點 | 描述 | 後果 |
|------|------|------|
| **鎖表停機** | 大表上執行 `ALTER TABLE`、`CREATE INDEX` | 服務中斷數分鐘到數小時 |
| **資料遺失** | 誤執行 `DROP TABLE`、`TRUNCATE` | 資料永久丟失 |
| **權限外洩** | DCL 寫錯授予過大權限 | 安全漏洞 |
| **無法回滾** | Down migration 沒寫或沒測試 | 事故無法快速恢復 |

### 1.2 開發效率類痛點

| 痛點 | 描述 | 影響 |
|------|------|------|
| **環境不一致** | 開發/測試/生產的 schema 版本不同 | Bug 難以重現，部署失敗 |
| **遷移衝突** | 多人同時開發，遷移順序混亂 | 合併時頻繁衝突 |
| **無測試機制** | 遷移腳本直接上線 | 生產環境當測試環境 |
| **缺乏審計** | 不知道誰改了什麼、何時改的 | 問題追溯困難 |

### 1.3 管理流程類痛點

| 痛點 | 描述 | 影響 |
|------|------|------|
| **權責不清** | DDL 和 DCL 混在一起 | 開發者可能誤改權限設定 |
| **無審核流程** | 危險操作沒有 Review | 風險完全暴露 |
| **手動執行** | DBA 手動跑 SQL | 人為失誤風險高 |
| **缺乏 Dry-Run** | 不知道會影響什麼 | 盲目執行 |

### 1.4 本系統如何解決這些痛點

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         解決方案對照表                                   │
├──────────────────────┬──────────────────────────────────────────────────┤
│ 痛點                 │ 解決方案                                         │
├──────────────────────┼──────────────────────────────────────────────────┤
│ 鎖表停機             │ 危險指令檢測（禁止非 CONCURRENTLY 索引）          │
│ 資料遺失             │ 禁止 DROP DATABASE / TRUNCATE                    │
│ 無法回滾             │ Up-Down-Up 三階段強制測試                        │
│ 環境不一致           │ 版本化 + changelog 追蹤                          │
│ 遷移衝突             │ 時間戳檔名 + CI 自動檢測                          │
│ 權責不清             │ DDL / DCL 目錄分離                               │
│ 無審核流程           │ PR Review + --allow-dangerous 旗標               │
│ 手動執行             │ K8s Job 自動化部署                               │
│ 缺乏 Dry-Run         │ --dry-run 模式預覽變更                           │
└──────────────────────┴──────────────────────────────────────────────────┘
```

---

## 二、Migration 工具核心功能解析

### 什麼是 Migration 工具？

Migration 工具的本質是**資料庫版本控制系統**，就像 Git 管理程式碼一樣，它管理資料庫結構的演進歷史。

```
┌─────────────────────────────────────────────────────────────────┐
│                    Migration 工具核心職責                         │
├─────────────────────────────────────────────────────────────────┤
│  1. 版本追蹤  │ 記錄哪些變更已套用、哪些待執行                      │
│  2. 順序執行  │ 確保變更按正確順序執行（時間戳排序）                 │
│  3. 雙向操作  │ up() 升級 / down() 回滾                           │
│  4. 冪等保證  │ 同一遷移只執行一次（透過 changelog 表追蹤）          │
│  5. 環境隔離  │ 開發/測試/生產環境各自獨立追蹤                      │
└─────────────────────────────────────────────────────────────────┘
```

### sql-migrate vs migrate-mongo 對比

| 特性 | sql-migrate (Go) | migrate-mongo (Node.js) |
|------|-----------------|------------------------|
| 遷移格式 | 純 SQL 檔案 | JavaScript 函數 |
| 追蹤表 | `gorp_migrations` | `changelog` |
| 執行方式 | CLI 或 Go 程式庫 | CLI 或 Node.js API |
| 回滾 | `-- +migrate Down` 區塊 | `export const down` 函數 |

### Migration 執行流程

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  讀取遷移   │ ──▶ │  檢查狀態   │ ──▶ │  執行遷移   │
│  目錄檔案   │     │  changelog  │     │  up / down  │
└─────────────┘     └─────────────┘     └─────────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  記錄結果   │
                    │  changelog  │
                    └─────────────┘
```

---

## 三、Up-Down-Up 三階段檢測機制

### 為什麼需要 Up-Down-Up？

**核心理念**：遷移腳本必須是**可逆的**，才能在出問題時快速回滾。

很多團隊只測試 `up()`，但 `down()` 從來沒跑過。等到生產環境出事需要回滾時，才發現：
- `down()` 根本沒寫
- `down()` 有語法錯誤
- `down()` 執行後狀態不對，再跑 `up()` 會失敗

### 三階段檢測流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Up-Down-Up 三階段檢測流程                             │
└─────────────────────────────────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────────────────────┐
     │                     Stage 1: UP                              │
     │  執行所有 pending 的 migration                                │
     └──────────────────────────────────────────────────────────────┘
                                 │
                                 │ 成功 ✓
                                 ▼
     ┌──────────────────────────────────────────────────────────────┐
     │                     Stage 2: DOWN                            │
     │  回滾所有剛執行的 migration                                   │
     │  驗證 down() 腳本是否正確                                     │
     └──────────────────────────────────────────────────────────────┘
                                 │
                                 │ 成功 ✓
                                 ▼
     ┌──────────────────────────────────────────────────────────────┐
     │                     Stage 3: UP (Again)                      │
     │  再次執行 up()，確認可重複執行                                │
     │  驗證 down() 確實還原到正確狀態                               │
     └──────────────────────────────────────────────────────────────┘
                                 │
                                 │ 成功 ✓
                                 ▼
                    ┌─────────────────────┐
                    │   ✅ 測試通過！      │
                    │   可以部署到生產     │
                    └─────────────────────┘
```

### 檢測什麼？

| 階段 | 檢測項目 | 失敗原因範例 |
|------|---------|-------------|
| **UP** | up() 語法正確、可執行 | SQL 語法錯誤、物件已存在 |
| **DOWN** | down() 存在且可執行 | 忘記寫 down()、語法錯誤 |
| **UP (Again)** | down() 還原狀態正確 | down() 沒刪乾淨、殘留資料 |

### 實作程式碼

```javascript
// src/testers/up-down-up-tester.js
export class UpDownUpTester {
  
  constructor(config) {
    this.config = config;
    this.results = {
      stage1_up: null,
      stage2_down: null,
      stage3_up: null
    };
  }

  async runFullTest() {
    console.log('🧪 Starting Up-Down-Up Test...\n');
    
    try {
      // Stage 1: UP
      console.log('📤 Stage 1: Running UP migrations...');
      this.results.stage1_up = await this.runUp();
      if (!this.results.stage1_up.success) {
        throw new Error(`Stage 1 (UP) failed: ${this.results.stage1_up.error}`);
      }
      console.log(`   ✅ Applied ${this.results.stage1_up.count} migrations\n`);
      
      // Stage 2: DOWN
      console.log('📥 Stage 2: Running DOWN migrations (rollback)...');
      this.results.stage2_down = await this.runDown();
      if (!this.results.stage2_down.success) {
        throw new Error(`Stage 2 (DOWN) failed: ${this.results.stage2_down.error}`);
      }
      console.log(`   ✅ Rolled back ${this.results.stage2_down.count} migrations\n`);
      
      // Stage 3: UP (Again)
      console.log('📤 Stage 3: Running UP migrations again...');
      this.results.stage3_up = await this.runUp();
      if (!this.results.stage3_up.success) {
        throw new Error(`Stage 3 (UP Again) failed: ${this.results.stage3_up.error}`);
      }
      console.log(`   ✅ Re-applied ${this.results.stage3_up.count} migrations\n`);
      
      // Verify counts match
      if (this.results.stage1_up.count !== this.results.stage3_up.count) {
        throw new Error(
          `Migration count mismatch: Stage 1 applied ${this.results.stage1_up.count}, ` +
          `Stage 3 applied ${this.results.stage3_up.count}. ` +
          `DOWN migration may not have fully reverted the changes.`
        );
      }
      
      console.log('═══════════════════════════════════════════');
      console.log('✅ Up-Down-Up Test PASSED!');
      console.log('   Your migrations are safe to deploy.');
      console.log('═══════════════════════════════════════════');
      
      return { success: true, results: this.results };
      
    } catch (error) {
      console.error('═══════════════════════════════════════════');
      console.error('❌ Up-Down-Up Test FAILED!');
      console.error(`   ${error.message}`);
      console.error('═══════════════════════════════════════════');
      
      return { success: false, error: error.message, results: this.results };
    }
  }
  
  async runUp() {
    // 實際執行 migrate up
    const startCount = await this.getAppliedCount();
    await migrateMongo.up(this.db, this.client);
    const endCount = await this.getAppliedCount();
    
    return {
      success: true,
      count: endCount - startCount
    };
  }
  
  async runDown() {
    // 執行所有 down migration
    const startCount = await this.getAppliedCount();
    
    // 逐一回滾
    while (await this.getAppliedCount() > 0) {
      await migrateMongo.down(this.db, this.client);
    }
    
    const endCount = await this.getAppliedCount();
    
    return {
      success: true,
      count: startCount - endCount
    };
  }
}
```

### CLI 使用方式

```bash
# 執行 Up-Down-Up 測試
npm run test:up-down-up -- -c databases/products/config.js

# 在 Docker 中執行（推薦，避免污染本地資料庫）
npm run docker:test -- --up-down-up

# CI/CD Pipeline 中執行
scripts/docker-test.sh --up-down-up
```

### 測試輸出範例

```
🧪 Starting Up-Down-Up Test...

📤 Stage 1: Running UP migrations...
   [UP] 20250101-create-users.sql
   [UP] 20250102-add-email-index.sql
   [UP] 20250103-create-orders.sql
   ✅ Applied 3 migrations

📥 Stage 2: Running DOWN migrations (rollback)...
   [DOWN] 20250103-create-orders.sql
   [DOWN] 20250102-add-email-index.sql
   [DOWN] 20250101-create-users.sql
   ✅ Rolled back 3 migrations

📤 Stage 3: Running UP migrations again...
   [UP] 20250101-create-users.sql
   [UP] 20250102-add-email-index.sql
   [UP] 20250103-create-orders.sql
   ✅ Re-applied 3 migrations

═══════════════════════════════════════════
✅ Up-Down-Up Test PASSED!
   Your migrations are safe to deploy.
═══════════════════════════════════════════
```

### 常見失敗情境

#### 情境 1：down() 沒寫

```sql
-- +migrate Up
CREATE TABLE users (id SERIAL PRIMARY KEY);

-- +migrate Down
-- 空的！忘記寫了
```

```
❌ Stage 2 (DOWN) failed: No down migration found
```

#### 情境 2：down() 沒刪乾淨

```sql
-- +migrate Up
CREATE TABLE users (id SERIAL PRIMARY KEY);
CREATE INDEX idx_users_id ON users(id);

-- +migrate Down
DROP TABLE users;  -- 忘記先刪索引！
```

```
✅ Stage 1: Applied 1 migrations
✅ Stage 2: Rolled back 1 migrations  
❌ Stage 3 (UP Again) failed: relation "users" already exists
   -- 因為 down 刪表時自動刪了索引，但如果有其他依賴就會出問題
```

#### 情境 3：down() 刪太多

```sql
-- +migrate Up
ALTER TABLE users ADD COLUMN phone VARCHAR(20);

-- +migrate Down
DROP TABLE users;  -- 太激進！應該只刪 column
```

```
✅ Stage 1: Applied 1 migrations
✅ Stage 2: Rolled back 1 migrations
❌ Stage 3 (UP Again) failed: relation "users" does not exist
   -- down() 把整個表刪了，再跑 up() 時 ALTER TABLE 找不到表
```

### 在 CI/CD 中強制執行

```yaml
# .github/workflows/migration.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run Up-Down-Up Test
        run: |
          npm run docker:test -- --up-down-up
        # 這個步驟失敗會阻止合併
```

---

## 四、危險操作放行機制

### 為什麼需要放行機制？

有些場景**必須執行危險操作**，例如：
- 清理已廢棄的暫存表
- 移除已下線功能的資料表
- 重建損壞的索引
- 緊急修復生產問題

但這些操作仍需要**受控且可追溯**的方式執行。

### 4.1 智慧型 DROP 放行（Create ↔ Drop 配對）

#### ❓ 常見問題：up() 建表，down() DROP 會被擋嗎？

**答案：不會！** 系統會自動檢測這種配對情況。

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    智慧型 Create ↔ Drop 配對檢測                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   up() 有 CREATE TABLE/createCollection                                  │
│                    ↓                                                     │
│   down() 有 DROP TABLE/drop                                              │
│                    ↓                                                     │
│   ✅ 自動放行！（顯示為 WARNING，但不阻止）                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 檢測邏輯（來自 validator 原始碼）

```javascript
// src/validators/mql-validator.js
// Special case: Allow 'drop' in down() if up() has createCollection
if ((operation === 'drop' || operation === 'dropCollection') && hasCreateCollection) {
  const hasDropInDown = this.containsOperation(downBody, operation);
  if (hasDropInDown && !this.containsOperation(upBody, operation)) {
    warnings.push({
      type: 'allowed-drop-for-create',
      operation,
      message: `[ALLOWED] ${operation} in down() because up() creates collection`,
      file: fileName,
    });
    continue;  // Skip the forbidden check
  }
}
```

#### 範例：這樣寫完全 OK ✅

```sql
-- +migrate Up
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    total DECIMAL(10,2)
);

-- +migrate Down
DROP TABLE IF EXISTS orders;  -- ✅ 自動放行，因為 up() 有 CREATE TABLE
```

```javascript
// MongoDB 版本
export const up = async (db) => {
  await db.createCollection('orders');  // 建立 collection
};

export const down = async (db) => {
  await db.collection('orders').drop();  // ✅ 自動放行
};
```

#### 驗證輸出

```bash
$ npm run validate -c databases/orders/config.js

[OK] 20250115-create-orders.js
   [WARN]  [ALLOWED] drop in down() because up() creates collection

[SUMMARY] Summary:
   Total files: 1
   Valid: 1

[OK] All validations passed!
```

#### ⚠️ 什麼情況會被擋？

| 情況 | up() | down() | 結果 |
|------|------|--------|------|
| ✅ 配對正確 | `CREATE TABLE orders` | `DROP TABLE orders` | 自動放行 |
| ✅ 配對正確 | `createCollection('orders')` | `.drop()` | 自動放行 |
| ❌ up 也有 DROP | `DROP TABLE old; CREATE TABLE new` | `DROP TABLE new` | 需要 migrate-ignore |
| ❌ 只有 DROP | 無 CREATE | `DROP TABLE legacy` | 需要審核放行 |
| ❌ 清理舊表 | 無 | `DROP TABLE temp_2024` | 需要審核放行 |

#### 需要手動放行的情況

如果你的 migration 是**單純刪除**（不是 Create/Drop 配對），才需要手動放行：

```sql
-- +migrate Up
-- migrate-ignore: drop
-- 審核單號: SEC-2025-001
-- 原因: 清理已廢棄的 legacy_orders 表
DROP TABLE IF EXISTS legacy_orders;

-- +migrate Down
SELECT 1;  -- 無法回滾
```

### 4.2 放行流程總覽

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        危險操作放行流程                                   │
└─────────────────────────────────────────────────────────────────────────┘

    ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
    │  開發者提交  │ ──▶ │  自動檢測   │ ──▶ │  標記危險   │
    │  Migration  │     │  危險操作   │     │  操作類型   │
    └─────────────┘     └─────────────┘     └─────────────┘
                                                   │
                                                   ▼
    ┌─────────────┐     ┌─────────────┐     ┌─────────────┐
    │  部署執行   │ ◀── │  DBA 審核   │ ◀── │  PR Review  │
    │  (放行)     │     │  + 簽核     │     │  + 說明原因  │
    └─────────────┘     └─────────────┘     └─────────────┘
```

### 4.2 腳本放行方式

#### 方式一：`migrate-ignore` 註解（單一操作）

在遷移檔案中加入特殊註解，跳過特定操作的檢查：

```sql
-- +migrate Up
-- migrate-ignore: drop
-- migrate-ignore: truncate
--
-- 審核單號: SEC-2025-001
-- 審核人: dba@company.com
-- 審核日期: 2025-01-15
-- 原因: 清理 2024 年前的暫存資料表，已確認無業務依賴
-- 影響範圍: 僅影響 legacy_temp_data 表，約 100GB 資料
-- 回滾計畫: 需從備份還原，預估時間 2 小時

DROP TABLE IF EXISTS legacy_temp_data;

-- +migrate Down
-- 此操作無法自動回滾
-- 回滾步驟：
-- 1. 從備份還原 legacy_temp_data 表
-- 2. 執行: pg_restore -t legacy_temp_data backup.dump
SELECT 1; -- placeholder
```

#### 方式二：`--allow-dangerous` 旗標（整個遷移）

用於 CI/CD 或手動執行時放行：

```bash
# 本地驗證（會顯示警告但不阻止）
npm run validate -c databases/products/config.js --allow-dangerous

# 執行遷移（需要特殊權限）
npm run up -c databases/products/config.js --allow-dangerous
```

#### 方式三：環境變數控制（CI/CD 專用）

```yaml
# .github/workflows/dangerous-migration.yml
name: Dangerous Migration (Requires Approval)

on:
  workflow_dispatch:  # 手動觸發
    inputs:
      migration_file:
        description: 'Migration file to execute'
        required: true
      reason:
        description: 'Reason for dangerous operation'
        required: true
      approver:
        description: 'DBA who approved this'
        required: true

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production-dangerous  # 需要額外審核的環境
    steps:
      - uses: actions/checkout@v4
      
      - name: Log approval info
        run: |
          echo "Migration: ${{ inputs.migration_file }}"
          echo "Reason: ${{ inputs.reason }}"
          echo "Approved by: ${{ inputs.approver }}"
          echo "Executed by: ${{ github.actor }}"
          echo "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
          
      - name: Run dangerous migration
        env:
          ALLOW_DANGEROUS: 'true'
        run: |
          npm run up -c databases/products/config.js --allow-dangerous
```

### 4.3 審核清單模板

```markdown
## 危險操作審核單

### 基本資訊
- **申請人**: @developer
- **申請日期**: 2025-01-15
- **緊急程度**: [ ] 緊急 [x] 一般

### 操作詳情
- **Migration 檔案**: `20250115-drop-legacy-table.sql`
- **危險操作類型**: DROP TABLE
- **目標物件**: `legacy_temp_data`
- **預估影響**: 刪除約 100GB 資料

### 必要性說明
此表為 2023 年遺留的暫存表，用於舊版報表系統。
舊報表系統已於 2024-06 下線，此表已 6 個月無任何查詢。

### 風險評估
- [ ] 已確認無應用程式依賴此表
- [ ] 已確認無排程任務依賴此表
- [ ] 已確認無其他表 FK 參照此表
- [ ] 已準備備份（備份位置: s3://backups/legacy_temp_data/）

### 回滾計畫
1. 從 S3 下載備份
2. 執行 pg_restore 還原
3. 預估還原時間: 2 小時

### 審核
- [ ] **Tech Lead 審核**: @tech-lead
- [ ] **DBA 審核**: @dba
- [ ] **已在 Staging 測試**: PR #123
```

### 4.4 放行後的追蹤記錄

```javascript
// 系統會自動記錄所有放行操作到 audit log
{
  "timestamp": "2025-01-15T10:30:00Z",
  "type": "dangerous_operation_executed",
  "migration": "20250115-drop-legacy-table.sql",
  "operation": "DROP TABLE",
  "target": "legacy_temp_data",
  "executor": "deploy-bot",
  "approver": "dba@company.com",
  "approval_ticket": "SEC-2025-001",
  "environment": "production",
  "flags_used": ["--allow-dangerous"],
  "ignore_comments": ["migrate-ignore: drop"]
}
```

### 4.5 危險等級分類

| 等級 | 操作 | 放行要求 |
|------|------|----------|
| 🔴 **CRITICAL** | `DROP DATABASE`, `TRUNCATE` | DBA + CTO 雙簽 |
| 🟠 **HIGH** | `DROP TABLE`, `DROP COLUMN` | DBA 審核 |
| 🟡 **MEDIUM** | `DELETE` 無 WHERE, `UPDATE` 無 WHERE | Tech Lead 審核 |
| 🟢 **LOW** | `CREATE INDEX` 非 CONCURRENTLY | 自動警告，可自行放行 |

---

## 五、DDL 新增欄位 Sanity Check 與自動回滾

### 為什麼需要 Sanity Check？

新增欄位看似簡單，但可能因為以下原因失敗：
- 欄位名稱已存在
- 資料類型不相容
- NOT NULL 沒有 DEFAULT 值（大表會鎖表）
- 外鍵參照的表/欄位不存在
- 磁碟空間不足

### 5.1 Sanity Check 流程

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    DDL 新增欄位完整流程                                   │
└─────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────────────────────┐
  │                        Phase 1: Pre-Check                            │
  ├──────────────────────────────────────────────────────────────────────┤
  │  1. 檢查欄位是否已存在                                                │
  │  2. 檢查資料類型是否有效                                              │
  │  3. 檢查 NOT NULL + DEFAULT 組合                                     │
  │  4. 檢查外鍵參照是否有效                                              │
  │  5. 預估執行時間（基於表大小）                                        │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 全部通過 ✓
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                        Phase 2: Execute UP                           │
  ├──────────────────────────────────────────────────────────────────────┤
  │  1. 開始 Transaction（如適用）                                        │
  │  2. 執行 ALTER TABLE ADD COLUMN                                      │
  │  3. 執行資料填充（如需要）                                            │
  │  4. 加入約束（NOT NULL, CHECK 等）                                   │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 成功 ✓
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │                        Phase 3: Post-Check (Sanity)                  │
  ├──────────────────────────────────────────────────────────────────────┤
  │  1. 確認欄位確實存在                                                  │
  │  2. 確認欄位類型正確                                                  │
  │  3. 確認約束已套用                                                    │
  │  4. 確認索引已建立（如有）                                            │
  │  5. 執行自訂驗證查詢                                                  │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                 成功 ✓                          失敗 ✗
                    │                               │
                    ▼                               ▼
           ┌──────────────┐                ┌──────────────────┐
           │   Commit     │                │  Auto Rollback   │
           │   完成！     │                │  執行 DOWN       │
           └──────────────┘                └──────────────────┘
```

### 5.2 Migration 寫法（含 Sanity Check）

```sql
-- +migrate Up
-- ============================================================
-- Migration: add-phone-to-users
-- Description: 新增 phone 欄位到 users 表
-- Author: developer@company.com
-- Date: 2025-01-15
-- ============================================================

-- Pre-Check: 確認欄位不存在（冪等性）
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user' AND column_name = 'phone'
    ) THEN
        RAISE NOTICE 'Column phone already exists, skipping...';
        RETURN;
    END IF;
    
    -- Step 1: 新增允許 NULL 的欄位（避免鎖表）
    ALTER TABLE "user" ADD COLUMN phone VARCHAR(20);
    
    -- Step 2: 填充預設值（批次處理）
    -- 對大表使用批次更新避免長時間鎖定
    UPDATE "user" SET phone = '' WHERE phone IS NULL;
    
    -- Step 3: 加入 NOT NULL 約束
    ALTER TABLE "user" ALTER COLUMN phone SET NOT NULL;
    ALTER TABLE "user" ALTER COLUMN phone SET DEFAULT '';
    
END $$;

-- Post-Check (Sanity Check): 驗證欄位正確建立
DO $$
DECLARE
    v_column_exists BOOLEAN;
    v_is_nullable VARCHAR(3);
    v_data_type VARCHAR(50);
BEGIN
    -- 檢查欄位存在
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'user' AND column_name = 'phone'
    ) INTO v_column_exists;
    
    IF NOT v_column_exists THEN
        RAISE EXCEPTION 'SANITY CHECK FAILED: Column phone does not exist!';
    END IF;
    
    -- 檢查資料類型
    SELECT data_type, is_nullable 
    INTO v_data_type, v_is_nullable
    FROM information_schema.columns 
    WHERE table_name = 'user' AND column_name = 'phone';
    
    IF v_data_type != 'character varying' THEN
        RAISE EXCEPTION 'SANITY CHECK FAILED: Column phone has wrong type: %', v_data_type;
    END IF;
    
    IF v_is_nullable != 'NO' THEN
        RAISE EXCEPTION 'SANITY CHECK FAILED: Column phone should be NOT NULL!';
    END IF;
    
    RAISE NOTICE 'SANITY CHECK PASSED: Column phone created successfully';
END $$;

-- +migrate Down
-- ============================================================
-- Rollback: 移除 phone 欄位
-- Warning: 此操作會刪除所有 phone 資料！
-- ============================================================
ALTER TABLE "user" DROP COLUMN IF EXISTS phone;
```

### 5.3 JavaScript 版本（MongoDB）

```javascript
// 20250115-add-phone-to-users.js
export const up = async (db, client) => {
  const session = client.startSession();
  
  try {
    await session.withTransaction(async () => {
      // ========================================
      // Pre-Check
      // ========================================
      console.log('[PRE-CHECK] Starting pre-flight checks...');
      
      // 檢查 collection 是否存在
      const collections = await db.listCollections({ name: 'users' }).toArray();
      if (collections.length === 0) {
        throw new Error('SANITY CHECK FAILED: Collection "users" does not exist!');
      }
      
      // 檢查是否已有 phone 欄位的文件
      const sampleDoc = await db.collection('users').findOne({ phone: { $exists: true } });
      if (sampleDoc) {
        console.log('[PRE-CHECK] Field "phone" already exists, checking schema...');
      }
      
      console.log('[PRE-CHECK] All checks passed ✓');
      
      // ========================================
      // Execute Migration
      // ========================================
      console.log('[MIGRATE] Adding phone field to all users...');
      
      const result = await db.collection('users').updateMany(
        { phone: { $exists: false } },  // 只更新沒有 phone 的文件
        { 
          $set: { 
            phone: '',
            phoneVerified: false,
            phoneUpdatedAt: new Date()
          } 
        }
      );
      
      console.log(`[MIGRATE] Updated ${result.modifiedCount} documents`);
      
      // 建立索引
      await db.collection('users').createIndex(
        { phone: 1 }, 
        { 
          sparse: true,  // 允許 null/空值
          background: true 
        }
      );
      
      console.log('[MIGRATE] Index created on phone field');
      
      // ========================================
      // Post-Check (Sanity Check)
      // ========================================
      console.log('[SANITY] Running post-migration checks...');
      
      // 1. 確認所有文件都有 phone 欄位
      const docsWithoutPhone = await db.collection('users').countDocuments({ 
        phone: { $exists: false } 
      });
      
      if (docsWithoutPhone > 0) {
        throw new Error(
          `SANITY CHECK FAILED: ${docsWithoutPhone} documents still missing phone field!`
        );
      }
      
      // 2. 確認索引存在
      const indexes = await db.collection('users').indexes();
      const phoneIndex = indexes.find(idx => idx.key && idx.key.phone === 1);
      
      if (!phoneIndex) {
        throw new Error('SANITY CHECK FAILED: Index on phone field not found!');
      }
      
      // 3. 自訂業務邏輯檢查（範例：確認資料完整性）
      const totalUsers = await db.collection('users').countDocuments();
      const usersWithPhone = await db.collection('users').countDocuments({ 
        phone: { $exists: true } 
      });
      
      if (totalUsers !== usersWithPhone) {
        throw new Error(
          `SANITY CHECK FAILED: User count mismatch! ` +
          `Total: ${totalUsers}, With phone: ${usersWithPhone}`
        );
      }
      
      console.log('[SANITY] All checks passed ✓');
      console.log(`[SANITY] Total users with phone field: ${usersWithPhone}`);
    });
    
  } catch (error) {
    // ========================================
    // Auto Rollback on Error
    // ========================================
    console.error('[ERROR] Migration failed:', error.message);
    console.log('[ROLLBACK] Initiating automatic rollback...');
    
    // Transaction 會自動 abort，但我們記錄一下
    throw error;  // 重新拋出讓框架處理回滾
    
  } finally {
    await session.endSession();
  }
};

export const down = async (db, client) => {
  console.log('[ROLLBACK] Removing phone field from users...');
  
  // 移除索引
  try {
    await db.collection('users').dropIndex('phone_1');
    console.log('[ROLLBACK] Index dropped');
  } catch (e) {
    console.log('[ROLLBACK] Index not found, skipping...');
  }
  
  // 移除欄位
  const result = await db.collection('users').updateMany(
    {},
    { 
      $unset: { 
        phone: '',
        phoneVerified: '',
        phoneUpdatedAt: ''
      } 
    }
  );
  
  console.log(`[ROLLBACK] Removed phone field from ${result.modifiedCount} documents`);
};
```

### 5.4 自動回滾觸發機制

```javascript
// src/runners/migration-runner.js
export class MigrationRunner {
  
  async runWithSanityCheck(migration, config) {
    const startTime = Date.now();
    let rollbackNeeded = false;
    
    try {
      // ========================================
      // Phase 1: Pre-Check
      // ========================================
      console.log('\n' + '='.repeat(60));
      console.log(`[PHASE 1] Pre-Check: ${migration.name}`);
      console.log('='.repeat(60));
      
      if (migration.preCheck) {
        const preCheckResult = await migration.preCheck(this.db);
        if (!preCheckResult.success) {
          throw new Error(`Pre-Check Failed: ${preCheckResult.error}`);
        }
      }
      
      // ========================================
      // Phase 2: Execute UP
      // ========================================
      console.log('\n' + '='.repeat(60));
      console.log(`[PHASE 2] Execute: ${migration.name}`);
      console.log('='.repeat(60));
      
      await migration.up(this.db, this.client);
      rollbackNeeded = true;  // 從這裡開始，失敗需要回滾
      
      // ========================================
      // Phase 3: Post-Check (Sanity)
      // ========================================
      console.log('\n' + '='.repeat(60));
      console.log(`[PHASE 3] Sanity Check: ${migration.name}`);
      console.log('='.repeat(60));
      
      if (migration.sanityCheck) {
        const sanityResult = await migration.sanityCheck(this.db);
        if (!sanityResult.success) {
          throw new Error(`Sanity Check Failed: ${sanityResult.error}`);
        }
      }
      
      // ========================================
      // Success
      // ========================================
      const duration = Date.now() - startTime;
      console.log('\n' + '='.repeat(60));
      console.log(`[SUCCESS] Migration completed in ${duration}ms`);
      console.log('='.repeat(60));
      
      return { success: true, duration };
      
    } catch (error) {
      // ========================================
      // Auto Rollback
      // ========================================
      console.error('\n' + '!'.repeat(60));
      console.error(`[FAILED] ${error.message}`);
      console.error('!'.repeat(60));
      
      if (rollbackNeeded) {
        console.log('\n[AUTO-ROLLBACK] Starting automatic rollback...');
        
        try {
          await migration.down(this.db, this.client);
          console.log('[AUTO-ROLLBACK] Rollback completed successfully');
        } catch (rollbackError) {
          console.error('[AUTO-ROLLBACK] Rollback FAILED:', rollbackError.message);
          console.error('[CRITICAL] Manual intervention required!');
          
          // 發送緊急告警
          await this.sendAlert({
            level: 'CRITICAL',
            message: 'Migration rollback failed',
            migration: migration.name,
            error: rollbackError.message
          });
        }
      }
      
      return { 
        success: false, 
        error: error.message,
        rolledBack: rollbackNeeded
      };
    }
  }
}
```

### 5.5 CLI 使用範例

```bash
# 執行遷移（含 Sanity Check）
npm run up -c databases/users/config.js

# 輸出範例：
# ============================================================
# [PHASE 1] Pre-Check: 20250115-add-phone-to-users
# ============================================================
# [PRE-CHECK] Checking if column exists... OK
# [PRE-CHECK] Checking table size... 1,234,567 rows
# [PRE-CHECK] Estimated execution time: ~30 seconds
# [PRE-CHECK] All checks passed ✓
#
# ============================================================
# [PHASE 2] Execute: 20250115-add-phone-to-users
# ============================================================
# [MIGRATE] Adding column phone...
# [MIGRATE] Filling default values...
# [MIGRATE] Setting NOT NULL constraint...
# [MIGRATE] Done!
#
# ============================================================
# [PHASE 3] Sanity Check: 20250115-add-phone-to-users
# ============================================================
# [SANITY] Verifying column exists... OK
# [SANITY] Verifying data type... OK (VARCHAR(20))
# [SANITY] Verifying NOT NULL constraint... OK
# [SANITY] All checks passed ✓
#
# ============================================================
# [SUCCESS] Migration completed in 28453ms
# ============================================================
```

### 5.6 失敗時的自動回滾輸出

```bash
# ============================================================
# [PHASE 1] Pre-Check: 20250115-add-phone-to-users
# ============================================================
# [PRE-CHECK] All checks passed ✓
#
# ============================================================
# [PHASE 2] Execute: 20250115-add-phone-to-users
# ============================================================
# [MIGRATE] Adding column phone...
# [MIGRATE] Filling default values...
# [MIGRATE] Done!
#
# ============================================================
# [PHASE 3] Sanity Check: 20250115-add-phone-to-users
# ============================================================
# [SANITY] Verifying column exists... OK
# [SANITY] Verifying data type... FAILED!
#
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
# [FAILED] Sanity Check Failed: Column phone has wrong type: TEXT
# !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
#
# [AUTO-ROLLBACK] Starting automatic rollback...
# [ROLLBACK] Removing column phone...
# [ROLLBACK] Done!
# [AUTO-ROLLBACK] Rollback completed successfully
#
# ============================================================
# [RESULT] Migration FAILED and was rolled back
# ============================================================
# Exit code: 1
```

### 5.7 常見 Sanity Check 項目

| 檢查項目 | SQL 範例 | 說明 |
|----------|----------|------|
| 欄位存在 | `SELECT column_name FROM information_schema.columns WHERE...` | 確認 DDL 成功 |
| 資料類型正確 | `SELECT data_type FROM information_schema.columns WHERE...` | 避免類型錯誤 |
| 約束已套用 | `SELECT is_nullable FROM information_schema.columns WHERE...` | 確認 NOT NULL |
| 索引已建立 | `SELECT indexname FROM pg_indexes WHERE...` | 效能保證 |
| 資料完整性 | `SELECT COUNT(*) WHERE column IS NULL` | 確認資料填充 |
| 外鍵有效 | `SELECT COUNT(*) FROM child LEFT JOIN parent...` | 參照完整性 |

---

## 六、DDL vs DCL 分離管理策略

### 定義

| 類型 | 全名 | 範例 | 管理者 |
|------|------|------|--------|
| **DDL** | Data Definition Language | `CREATE TABLE`, `ALTER TABLE`, `CREATE INDEX` | 開發者 |
| **DCL** | Data Control Language | `CREATE USER`, `GRANT`, `REVOKE` | DBA/平台團隊 |

### 為什麼要分離？

1. **權責分離**：安全性相關變更需要更高的審核權限
2. **執行時機不同**：DCL 通常在環境初始化時執行，DDL 在應用部署時執行
3. **冪等性要求不同**：DCL 必須冪等，DDL 使用版本控制
4. **風險等級不同**：錯誤的 DCL 可能導致全系統無法存取

### 架構設計

```
databases/
├── _platform/                    # DCL - 平台團隊管理
│   ├── config.js
│   └── migrations/
│       ├── 00000001-init-roles.sql
│       ├── 00000002-app-user.sql
│       └── 00000003-readonly-user.sql
│
├── products/                     # DDL - 開發團隊 A
│   ├── config.js
│   └── migrations/
│       ├── 20250101-create-products.sql
│       └── 20250102-add-index.sql
│
└── orders/                       # DDL - 開發團隊 B
    ├── config.js
    └── migrations/
```

---

## 七、DCL 管理規則（平台團隊）

### 3.1 冪等性設計原則

DCL 必須是**冪等的**（執行多次結果相同），因為權限狀態可能被手動修改。

#### PostgreSQL 冪等寫法

```sql
-- ❌ 錯誤：不冪等，執行兩次會報錯
CREATE USER app_user WITH PASSWORD 'secret';
GRANT SELECT ON products TO app_user;

-- ✅ 正確：冪等寫法
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
        CREATE USER app_user WITH PASSWORD 'secret';
    END IF;
END $$;

-- 使用 IF NOT EXISTS（PostgreSQL 9.6+）
GRANT SELECT ON products TO app_user;  -- GRANT 本身是冪等的
```

#### MySQL 冪等寫法

```sql
-- ❌ 錯誤
CREATE USER 'app_user'@'%' IDENTIFIED BY 'secret';

-- ✅ 正確
CREATE USER IF NOT EXISTS 'app_user'@'%' IDENTIFIED BY 'secret';
ALTER USER 'app_user'@'%' IDENTIFIED BY 'secret';  -- 確保密碼正確
GRANT SELECT ON products.* TO 'app_user'@'%';
FLUSH PRIVILEGES;
```

### 3.2 DCL 驗證規則

```javascript
// src/config/dcl-validation-rules.js
export const dclValidationRules = {
  // 必須檢查的冪等模式
  required: {
    patterns: [
      {
        name: 'idempotent-create-user',
        description: 'CREATE USER 必須有 IF NOT EXISTS 或包在存在性檢查中',
        regex: /CREATE\s+USER\s+(?!IF\s+NOT\s+EXISTS)/i,
        shouldNotMatch: true,
        message: 'CREATE USER 必須使用 IF NOT EXISTS 或 DO $$ 區塊包裹'
      },
      {
        name: 'idempotent-create-role',
        description: 'CREATE ROLE 必須有 IF NOT EXISTS',
        regex: /CREATE\s+ROLE\s+(?!IF\s+NOT\s+EXISTS)/i,
        shouldNotMatch: true,
        message: 'CREATE ROLE 必須使用 IF NOT EXISTS'
      }
    ]
  },

  // 禁止的操作
  forbidden: {
    operations: [
      {
        pattern: /DROP\s+USER\s+(?!IF\s+EXISTS)/i,
        message: 'DROP USER 必須使用 IF EXISTS'
      },
      {
        pattern: /REVOKE\s+ALL/i,
        message: '禁止 REVOKE ALL，請明確指定要撤銷的權限'
      },
      {
        pattern: /WITH\s+GRANT\s+OPTION/i,
        message: '禁止授予 WITH GRANT OPTION，避免權限擴散'
      },
      {
        pattern: /SUPERUSER|CREATEDB|CREATEROLE/i,
        message: '禁止授予超級使用者權限，應由 DBA 手動處理'
      }
    ]
  },

  // 必須包含的內容
  mandatory: {
    patterns: [
      {
        name: 'has-rollback',
        description: '必須有回滾腳本',
        check: (content, metadata) => {
          return metadata.hasDownMigration;
        },
        message: 'DCL 變更必須提供回滾腳本'
      }
    ]
  },

  // 警告級別
  warnings: {
    patterns: [
      {
        pattern: /PASSWORD\s*=?\s*['"][^'"]+['"]/i,
        message: '警告：密碼不應硬編碼，請使用環境變數或 Vault'
      },
      {
        pattern: /GRANT.*ON\s+\*\.\*/i,
        message: '警告：授予全域權限風險較高，請確認必要性'
      }
    ]
  }
};
```

### 3.3 DCL 冪等性檢查器

```javascript
// src/validators/dcl-idempotency-checker.js
export class DCLIdempotencyChecker {
  
  /**
   * 檢查 SQL 是否為冪等
   */
  checkIdempotency(sql, dialect = 'postgresql') {
    const issues = [];
    const statements = this.parseStatements(sql);
    
    for (const stmt of statements) {
      const check = this.checkStatement(stmt, dialect);
      if (!check.idempotent) {
        issues.push({
          statement: stmt.text.substring(0, 100),
          line: stmt.line,
          issue: check.issue,
          suggestion: check.suggestion
        });
      }
    }
    
    return {
      isIdempotent: issues.length === 0,
      issues
    };
  }
  
  checkStatement(stmt, dialect) {
    const text = stmt.text.toUpperCase();
    
    // CREATE USER 檢查
    if (text.includes('CREATE USER') && !text.includes('IF NOT EXISTS')) {
      if (dialect === 'postgresql' && !this.isWrappedInExistsCheck(stmt)) {
        return {
          idempotent: false,
          issue: 'CREATE USER 不是冪等的',
          suggestion: dialect === 'postgresql' 
            ? '使用 DO $$ BEGIN IF NOT EXISTS... END $$'
            : '使用 CREATE USER IF NOT EXISTS'
        };
      }
    }
    
    // CREATE ROLE 檢查
    if (text.includes('CREATE ROLE') && !text.includes('IF NOT EXISTS')) {
      return {
        idempotent: false,
        issue: 'CREATE ROLE 不是冪等的',
        suggestion: '使用 CREATE ROLE IF NOT EXISTS（需 PostgreSQL 9.6+）'
      };
    }
    
    // DROP 檢查
    if ((text.includes('DROP USER') || text.includes('DROP ROLE')) 
        && !text.includes('IF EXISTS')) {
      return {
        idempotent: false,
        issue: 'DROP 操作不是冪等的',
        suggestion: '使用 DROP ... IF EXISTS'
      };
    }
    
    // GRANT/REVOKE 本身是冪等的
    return { idempotent: true };
  }
  
  isWrappedInExistsCheck(stmt) {
    return /DO\s+\$\$[\s\S]*IF\s+NOT\s+EXISTS[\s\S]*\$\$/i.test(stmt.context);
  }
}
```

---

## 八、DDL 管理規則（開發團隊）

### 4.1 版本化設計原則

DDL 使用**版本化**而非冪等（每個版本只執行一次）：

```
migrations/
├── 20250101120000-create-users-table.sql      # v1
├── 20250101130000-add-email-index.sql         # v2
├── 20250102100000-add-phone-column.sql        # v3
└── 20250103090000-create-orders-table.sql     # v4

changelog 表：
┌─────────────────────────────────┬─────────────────────┐
│ filename                        │ applied_at          │
├─────────────────────────────────┼─────────────────────┤
│ 20250101120000-create-users     │ 2025-01-01 12:00:00 │
│ 20250101130000-add-email-index  │ 2025-01-01 13:00:00 │
│ 20250102100000-add-phone-column │ 2025-01-02 10:00:00 │
└─────────────────────────────────┴─────────────────────┘
```

### 4.2 危險指令檢查規則

```javascript
// src/config/ddl-validation-rules.js
export const ddlValidationRules = {
  // 禁止的操作（硬性禁止）
  forbidden: {
    // 資料庫級別
    database: [
      { pattern: /DROP\s+DATABASE/i, message: 'DATA LOSS: 禁止刪除資料庫' },
      { pattern: /TRUNCATE\s+TABLE/i, message: 'DATA LOSS: 禁止 TRUNCATE，使用 DELETE 並提供回滾' },
    ],
    
    // 權限相關（應由 DCL 處理）
    dcl: [
      { pattern: /CREATE\s+USER/i, message: 'DCL: 使用者管理應在 _platform 專案' },
      { pattern: /DROP\s+USER/i, message: 'DCL: 使用者管理應在 _platform 專案' },
      { pattern: /GRANT\s+/i, message: 'DCL: 權限管理應在 _platform 專案' },
      { pattern: /REVOKE\s+/i, message: 'DCL: 權限管理應在 _platform 專案' },
    ],
    
    // 鎖表操作
    blocking: [
      { pattern: /LOCK\s+TABLE/i, message: 'BLOCKING: 禁止手動鎖表' },
      { pattern: /ALTER\s+TABLE.*ADD\s+COLUMN.*NOT\s+NULL(?!\s+DEFAULT)/i, 
        message: 'BLOCKING: 新增 NOT NULL 欄位必須有 DEFAULT 值（大表會鎖表）' },
    ],
    
    // 索引危險操作
    index: [
      { pattern: /REINDEX/i, message: 'BLOCKING: REINDEX 會鎖表，使用 CONCURRENTLY' },
      { pattern: /CREATE\s+INDEX\s+(?!CONCURRENTLY)/i, 
        message: 'BLOCKING: 請使用 CREATE INDEX CONCURRENTLY' },
      { pattern: /DROP\s+INDEX\s+(?!CONCURRENTLY)/i, 
        message: 'BLOCKING: 請使用 DROP INDEX CONCURRENTLY' },
    ]
  },

  // 需要審核的操作（警告）
  warnings: {
    dataModification: [
      { pattern: /DELETE\s+FROM/i, message: '警告: DELETE 操作，請確認有 WHERE 條件' },
      { pattern: /UPDATE\s+.*SET/i, message: '警告: UPDATE 操作，請確認有 WHERE 條件' },
      { pattern: /ALTER\s+TABLE.*DROP\s+COLUMN/i, message: '警告: 刪除欄位會造成資料遺失' },
    ],
    
    schemaChange: [
      { pattern: /ALTER\s+TABLE.*ALTER\s+COLUMN.*TYPE/i, 
        message: '警告: 改變欄位類型可能造成資料轉換問題' },
      { pattern: /RENAME\s+(TABLE|COLUMN)/i, 
        message: '警告: 重新命名會影響現有查詢' },
    ]
  },

  // 必要條件檢查
  required: {
    patterns: [
      {
        name: 'where-clause-for-delete',
        check: (sql) => {
          const deleteStatements = sql.match(/DELETE\s+FROM\s+\w+/gi) || [];
          for (const del of deleteStatements) {
            const afterDelete = sql.substring(sql.indexOf(del));
            const statement = afterDelete.split(';')[0];
            if (!/WHERE/i.test(statement)) {
              return { valid: false, message: 'DELETE 必須有 WHERE 條件' };
            }
          }
          return { valid: true };
        }
      },
      {
        name: 'where-clause-for-update',
        check: (sql) => {
          const updateStatements = sql.match(/UPDATE\s+\w+\s+SET/gi) || [];
          for (const upd of updateStatements) {
            const afterUpdate = sql.substring(sql.indexOf(upd));
            const statement = afterUpdate.split(';')[0];
            if (!/WHERE/i.test(statement)) {
              return { valid: false, message: 'UPDATE 必須有 WHERE 條件' };
            }
          }
          return { valid: true };
        }
      }
    ]
  }
};
```

### 4.3 Sanity Check（合理性檢查）

```javascript
// src/validators/ddl-sanity-checker.js
export class DDLSanityChecker {
  
  constructor(options = {}) {
    this.maxColumnsPerTable = options.maxColumnsPerTable || 50;
    this.maxIndexesPerTable = options.maxIndexesPerTable || 10;
  }

  /**
   * 執行完整 Sanity Check
   */
  async check(sql, context = {}) {
    const results = {
      valid: true,
      errors: [],
      warnings: [],
      suggestions: []
    };

    // 1. 語法檢查
    this.checkSyntax(sql, results);
    
    // 2. 命名規範檢查
    this.checkNamingConventions(sql, results);
    
    // 3. 資料類型檢查
    this.checkDataTypes(sql, results);
    
    // 4. 索引合理性檢查
    this.checkIndexes(sql, results);
    
    // 5. 外鍵檢查
    this.checkForeignKeys(sql, results);
    
    // 6. 欄位數量檢查
    this.checkColumnCount(sql, results);
    
    // 7. 回滾可行性檢查
    this.checkRollbackFeasibility(sql, context, results);

    results.valid = results.errors.length === 0;
    return results;
  }

  checkSyntax(sql, results) {
    const issues = [
      { pattern: /,\s*\)/g, message: '語法錯誤: 多餘的逗號在右括號前' },
      { pattern: /\(\s*,/g, message: '語法錯誤: 多餘的逗號在左括號後' },
      { pattern: /,,/g, message: '語法錯誤: 連續逗號' },
      { pattern: /;\s*;/g, message: '語法錯誤: 連續分號' },
    ];
    
    for (const issue of issues) {
      if (issue.pattern.test(sql)) {
        results.errors.push({ type: 'syntax', message: issue.message });
      }
    }
  }

  checkNamingConventions(sql, results) {
    // 表名：snake_case
    const tableMatches = sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi);
    for (const match of tableMatches) {
      const tableName = match[1];
      
      if (tableName !== tableName.toLowerCase()) {
        results.warnings.push({
          type: 'naming',
          message: `表名 "${tableName}" 應使用小寫 snake_case`
        });
      }
      
      // 檢查保留字
      if (this.isReservedWord(tableName)) {
        results.errors.push({
          type: 'naming',
          message: `表名 "${tableName}" 是 SQL 保留字`
        });
      }
    }
  }

  checkDataTypes(sql, results) {
    // VARCHAR 應有長度限制
    if (/VARCHAR(?!\s*\(\d+\))/i.test(sql)) {
      results.warnings.push({
        type: 'datatype',
        message: 'VARCHAR 應指定長度限制'
      });
    }
    
    // DECIMAL 應有精度
    if (/DECIMAL(?!\s*\(\d+)/i.test(sql)) {
      results.warnings.push({
        type: 'datatype',
        message: 'DECIMAL 應指定精度，如 DECIMAL(10,2)'
      });
    }
    
    // 建議使用 TIMESTAMPTZ
    if (/\bTIMESTAMP\b(?!\s*WITH\s+TIME\s+ZONE|\s*TZ)/i.test(sql)) {
      results.suggestions.push({
        type: 'datatype',
        message: '建議使用 TIMESTAMPTZ 處理時區'
      });
    }
  }

  checkIndexes(sql, results) {
    if (/CREATE\s+INDEX\s+(?!CONCURRENTLY)/i.test(sql)) {
      results.warnings.push({
        type: 'index',
        message: '生產環境應使用 CREATE INDEX CONCURRENTLY 避免鎖表'
      });
    }
  }

  checkForeignKeys(sql, results) {
    if (/REFERENCES\s+\w+.*(?!ON\s+DELETE)/i.test(sql)) {
      results.warnings.push({
        type: 'foreignkey',
        message: '外鍵應指定 ON DELETE 行為 (CASCADE, SET NULL, RESTRICT)'
      });
    }
  }

  checkColumnCount(sql, results) {
    const createTableMatches = sql.matchAll(/CREATE\s+TABLE[^;]+/gi);
    for (const match of createTableMatches) {
      const tableDefinition = match[0];
      const columnCount = (tableDefinition.match(/,/g) || []).length + 1;
      
      if (columnCount > this.maxColumnsPerTable) {
        results.warnings.push({
          type: 'design',
          message: `表定義包含 ${columnCount} 個欄位，超過建議上限 ${this.maxColumnsPerTable}`
        });
      }
    }
  }

  checkRollbackFeasibility(sql, context, results) {
    if (!context.hasDownMigration) {
      results.warnings.push({
        type: 'rollback',
        message: '缺少回滾腳本 (down migration)'
      });
    }
    
    if (/DROP\s+COLUMN/i.test(sql)) {
      results.warnings.push({
        type: 'rollback',
        message: 'DROP COLUMN 會造成資料遺失，無法完全回滾'
      });
    }
  }

  isReservedWord(word) {
    const reserved = [
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'FROM', 'WHERE', 'TABLE',
      'INDEX', 'CREATE', 'DROP', 'ALTER', 'USER', 'ORDER', 'GROUP',
      'BY', 'JOIN', 'LEFT', 'RIGHT', 'ON', 'AND', 'OR', 'NOT', 'NULL'
    ];
    return reserved.includes(word.toUpperCase());
  }
}
```

---

## 九、完整管理規則總覽

### 規則分類表

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Migration 管理規則總覽                           │
├───────────┬──────────────────────────────────────────────────────────────┤
│   類型    │                           規則                                │
├───────────┼──────────────────────────────────────────────────────────────┤
│           │ ✗ DROP DATABASE                                              │
│           │ ✗ TRUNCATE TABLE                                             │
│ DDL 禁止  │ ✗ CREATE/DROP USER (應使用 DCL)                               │
│           │ ✗ GRANT/REVOKE (應使用 DCL)                                   │
│           │ ✗ CREATE INDEX 不帶 CONCURRENTLY                             │
│           │ ✗ ADD COLUMN NOT NULL 沒有 DEFAULT                           │
├───────────┼──────────────────────────────────────────────────────────────┤
│           │ ⚠ DELETE/UPDATE 無 WHERE                                     │
│ DDL 警告  │ ⚠ DROP COLUMN (資料遺失)                                      │
│           │ ⚠ ALTER COLUMN TYPE (類型轉換)                                │
│           │ ⚠ RENAME TABLE/COLUMN                                        │
├───────────┼──────────────────────────────────────────────────────────────┤
│           │ ✓ 必須使用 IF NOT EXISTS / IF EXISTS                          │
│ DCL 冪等  │ ✓ CREATE USER 要包在存在性檢查中                               │
│           │ ✓ GRANT/REVOKE 本身是冪等的                                    │
│           │ ✓ 禁止硬編碼密碼                                              │
├───────────┼──────────────────────────────────────────────────────────────┤
│           │ ✗ WITH GRANT OPTION                                          │
│ DCL 禁止  │ ✗ SUPERUSER / CREATEDB / CREATEROLE                           │
│           │ ✗ REVOKE ALL                                                 │
├───────────┼──────────────────────────────────────────────────────────────┤
│           │ ✓ 表名/欄位名使用 snake_case                                   │
│  Sanity   │ ✓ VARCHAR 指定長度                                            │
│  Check    │ ✓ DECIMAL 指定精度                                            │
│           │ ✓ 外鍵指定 ON DELETE 行為                                      │
│           │ ✓ 索引明確命名                                                │
│           │ ✓ 必須有 down migration                                       │
└───────────┴──────────────────────────────────────────────────────────────┘
```

### 錯誤等級定義

| 等級 | 說明 | CI 行為 |
|------|------|---------|
| 🔴 **ERROR** | 違反禁止規則 | 阻止合併 |
| 🟡 **WARNING** | 需要人工審核 | 需要 Approval |
| 🔵 **SUGGESTION** | 最佳實踐建議 | 僅顯示提示 |

---

## 十、使用情境指南

### 情境 1：開發者新增資料表

```bash
# 1. 建立遷移檔案
npm run create -c databases/products/config.js "create-orders-table"

# 2. 編輯遷移檔案
```

```sql
-- +migrate Up
CREATE TABLE IF NOT EXISTS "order" (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    CONSTRAINT fk_order_user FOREIGN KEY (user_id)
        REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_user_id 
    ON "order"(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_order_status 
    ON "order"(status);

-- +migrate Down
DROP INDEX CONCURRENTLY IF EXISTS idx_order_status;
DROP INDEX CONCURRENTLY IF EXISTS idx_order_user_id;
DROP TABLE IF EXISTS "order";
```

```bash
# 3. 驗證
npm run validate -c databases/products/config.js

# 4. 本地測試
npm run docker:test

# 5. 提交
git add . && git commit -m "feat: add orders table"
```

### 情境 2：平台團隊建立應用程式帳號

```bash
# 1. 建立 DCL 遷移
npm run create -c databases/_platform/config.js "create-products-app-user"
```

```sql
-- +migrate Up
-- PostgreSQL 冪等寫法
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'products_app') THEN
        CREATE USER products_app WITH PASSWORD '${PRODUCTS_APP_PASSWORD}';
    END IF;
END $$;

-- 授予權限（GRANT 本身是冪等的）
GRANT CONNECT ON DATABASE products TO products_app;
GRANT USAGE ON SCHEMA public TO products_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO products_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO products_app;

-- 設定預設權限給未來建立的物件
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO products_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public 
    GRANT USAGE, SELECT ON SEQUENCES TO products_app;

-- +migrate Down
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM products_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM products_app;
REVOKE USAGE ON SCHEMA public FROM products_app;
REVOKE CONNECT ON DATABASE products FROM products_app;
DROP USER IF EXISTS products_app;
```

### 情境 3：新增欄位（安全方式）

```bash
npm run create -c databases/users/config.js "add-phone-to-users"
```

```sql
-- +migrate Up
-- 安全方式：先加 NULL 允許的欄位
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

-- 填充預設值（批次處理避免長時間鎖表）
UPDATE "user" SET phone = '' WHERE phone IS NULL;

-- 再加 NOT NULL 約束
ALTER TABLE "user" ALTER COLUMN phone SET NOT NULL;
ALTER TABLE "user" ALTER COLUMN phone SET DEFAULT '';

-- +migrate Down
ALTER TABLE "user" DROP COLUMN IF EXISTS phone;
```

### 情境 4：危險操作需要例外處理

```bash
# 需要刪除舊表（經審核批准）
npm run create -c databases/products/config.js "drop-legacy-temp-table"
```

```sql
-- +migrate Up
-- migrate-ignore: drop
-- 審核單號: SEC-2025-001
-- 審核人: dba@company.com
-- 原因: 清理已廢棄的暫存表，無業務資料
DROP TABLE IF EXISTS legacy_temp_data;

-- +migrate Down
-- 無法回滾（表已刪除）
-- 需要從備份還原
SELECT 1; -- placeholder
```

```bash
# 使用 --allow-dangerous 旗標（需審核權限）
npm run validate -c databases/products/config.js --allow-dangerous
```

### 情境 5：大表新增索引（零停機）

```sql
-- +migrate Up
-- 大表新增索引：使用 CONCURRENTLY 避免鎖表
-- 注意：CONCURRENTLY 不能在 transaction 中執行

-- 先建立索引（可能需要數分鐘到數小時）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_created_at 
    ON orders(created_at);

-- 驗證索引狀態
-- SELECT indexrelid::regclass, indisvalid FROM pg_index 
-- WHERE indexrelid = 'idx_orders_created_at'::regclass;

-- +migrate Down
DROP INDEX CONCURRENTLY IF EXISTS idx_orders_created_at;
```

---

## 十一、CI/CD Pipeline 整合

### GitHub Actions 範例

```yaml
# .github/workflows/migration.yml
name: Migration Pipeline

on:
  push:
    paths:
      - 'databases/**'
  pull_request:
    paths:
      - 'databases/**'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Validate DDL migrations
        run: |
          for config in databases/*/config.js; do
            # Skip _platform (DCL)
            if [[ "$config" == *"_platform"* ]]; then
              continue
            fi
            echo "Validating DDL: $config..."
            npm run validate -- -c "$config"
          done
          
      - name: Validate DCL migrations (idempotency check)
        run: |
          if [ -d "databases/_platform" ]; then
            echo "Validating DCL: databases/_platform/config.js..."
            npm run validate:dcl -- -c databases/_platform/config.js
          fi

  test:
    needs: validate
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
          
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Run migration tests
        env:
          DATABASE_URL: postgres://postgres:postgres@localhost:5432/test_db
        run: npm run docker:test

  deploy-staging:
    needs: test
    if: github.ref == 'refs/heads/develop'
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy to Staging
        run: |
          helm upgrade --install migration ./charts/sql-migrate \
            --namespace staging \
            --set dbNames="products,orders" \
            --set dryRun=false \
            --set existingSecret="db-credentials"

  deploy-production:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      
      - name: Dry Run First
        run: |
          helm upgrade --install migration ./charts/sql-migrate \
            --namespace production \
            --set dbNames="products,orders" \
            --set dryRun=true \
            --set existingSecret="db-credentials"
            
      - name: Deploy to Production
        run: |
          helm upgrade --install migration ./charts/sql-migrate \
            --namespace production \
            --set dbNames="products,orders" \
            --set dryRun=false \
            --set existingSecret="db-credentials"
```

### 部署前檢查清單

```markdown
## Migration 部署前檢查清單

### 基本檢查
- [ ] 所有遷移已通過 `npm run validate`
- [ ] 所有遷移已通過 `npm run docker:test`
- [ ] 所有遷移都有對應的 down migration
- [ ] 已在 staging 環境驗證

### DDL 特定檢查
- [ ] 新表/新欄位的命名符合規範
- [ ] 新索引使用 CONCURRENTLY
- [ ] 大表變更已評估影響時間
- [ ] 不包含 DCL 操作

### DCL 特定檢查
- [ ] 所有操作都是冪等的
- [ ] 密碼使用環境變數或 Vault
- [ ] 已通過安全團隊審核
- [ ] 有明確的權限範圍說明

### 回滾準備
- [ ] Down migration 已測試
- [ ] 已準備資料備份計畫
- [ ] 已準備回滾 SOP
```

---

## 附錄 A：常見錯誤與修正

| 錯誤 | 原因 | 修正方式 |
|------|------|----------|
| `CREATE INDEX` blocked | 未使用 CONCURRENTLY | `CREATE INDEX CONCURRENTLY` |
| `ADD COLUMN NOT NULL` blocked | 缺少 DEFAULT | 分步驟：先 NULL → 填值 → NOT NULL |
| `CREATE USER` not idempotent | 未檢查存在性 | 使用 `IF NOT EXISTS` 或 DO $$ |
| `DELETE` blocked | 缺少 WHERE | 加上 WHERE 條件 |
| Table name is reserved | 使用了 SQL 保留字 | 改用其他名稱或加引號 |

---

## 附錄 B：相關資源

- [sql-migrate](https://github.com/rubenv/sql-migrate) - Go SQL Migration
- [migrate-mongo](https://github.com/seppevs/migrate-mongo) - Node.js MongoDB Migration
- [PostgreSQL ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [Zero-Downtime Migrations](https://blog.cloudflare.com/zero-downtime-schema-migrations/)

---

*文件版本: 1.0.0*  
*最後更新: 2026-01-20*
