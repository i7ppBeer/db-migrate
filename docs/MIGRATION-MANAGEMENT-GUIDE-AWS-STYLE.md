# 未來新聞稿 (Internal Press Release)

> *這是一份 AWS Working Backwards 風格的內部文件，用於在開發前釐清產品願景與客戶價值。*

---

## db-migrate 正式發布：終結「資料庫變更恐懼症」

**開發團隊不再害怕週五部署資料庫變更**

---

**2026 年 Q2** — 今天，我們發布 db-migrate，一套專為解決「資料庫變更恐懼症」而生的遷移管理系統。

### 我們要解決的問題

在與超過 50 個開發團隊深度訪談後，我們發現一個驚人的事實：

> **「我們的 down migration 從來沒測過。」**

這不是個案，而是業界常態。以下是我們收集到的真實痛點：

---

#### 😰 痛點一：回滾腳本永遠沒測過

*「寫 down migration 只是為了通過 Code Review，從來沒人真的跑過。直到出事那天，才發現根本跑不動。」*

**數據**：90% 的團隊從未在部署前測試過回滾腳本。

**後果**：當生產環境出問題需要回滾時，平均需要 2-4 小時手動修復，而不是預期的 5 分鐘自動回滾。

---

#### 😱 痛點二：危險操作悄悄混入

*「Junior 工程師不小心在 migration 裡寫了 DROP DATABASE，Code Review 沒注意到就合併了。」*

**數據**：65% 的資料庫相關生產事故，源於未被 Review 發現的危險操作。

**後果**：資料永久丟失、服務長時間中斷、客戶信任受損。

---

#### 😤 痛點三：遷移執行完才知道有問題

*「Migration 跑完說成功，結果業務邏輯全壞了。因為欄位加了，但資料沒填對。」*

**數據**：40% 的遷移問題在執行後數小時甚至數天才被發現。

**後果**：發現太晚，已經無法簡單回滾，需要寫補償腳本修復資料。

---

#### 😵 痛點四：權限管理混亂

*「開發者可以直接改資料庫權限，有人不小心把 root 密碼寫進 migration 裡 commit 上去了。」*

**數據**：25% 的安全事件與資料庫權限變更相關。

**後果**：敏感資訊外洩、權限被濫用、合規審計失敗。

---

### 我們的解決方案

db-migrate 針對上述每一個痛點，提供對應的解決機制：

| 痛點 | 解決方案 | 效果 |
|------|----------|------|
| 回滾腳本沒測過 | **Up-Down-Up 三階段強制測試** | 回滾成功率 30% → 95% |
| 危險操作混入 | **危險操作自動攔截 + 智慧配對檢測** | 危險操作 100% 攔截或標記 |
| 執行完才知有問題 | **Sanity Check + 自動回滾** | 問題發現時間：數小時 → 數秒 |
| 權限管理混亂 | **DDL/DCL 強制分離** | 權限變更必須獨立審核 |

---

### 客戶證言

> *「導入 db-migrate 後，我們終於敢在週五下午部署資料庫變更了。因為我們知道，就算出問題，5 分鐘內就能自動回滾。」*
>
> — 某電商平台 SRE 主管

---

### 可用性

db-migrate 現已開源（MIT 授權），支援 MongoDB 與 MariaDB/MySQL，提供 CLI、Docker Image 與 Kubernetes Helm Chart。

---

# 常見問題 (FAQ)

## 客戶常見問題

### Q1: 為什麼現有的遷移工具解決不了這些問題？

**A:** 現有工具（migrate-mongo、Flyway、Liquibase）專注於「版本控制」——記錄哪些遷移已執行。但這不是真正的問題所在。

真正的問題是：
- **沒有機制強制測試回滾** → 工具不會阻止你部署未測試的回滾腳本
- **沒有機制攔截危險操作** → DROP DATABASE 可以堂而皇之地通過
- **沒有機制驗證執行結果** → 執行「成功」不代表結果「正確」

db-migrate 不是要取代版本控制，而是在版本控制之上，加上「安全機制」。

---

### Q2: 什麼是「Up-Down-Up 三階段強制測試」？為什麼這很重要？

**A:** 這是 db-migrate 的核心機制：

```
UP (升級) → DOWN (回滾) → UP (再次升級)
```

**為什麼這很重要？**

想像一個場景：你寫了一個 migration 新增欄位，然後寫了 down migration 刪除欄位。看起來很完美，對吧？

但如果：
- down migration 有語法錯誤？
- down migration 刪錯欄位？
- down migration 之後，up migration 跑不動了（因為有殘留資料）？

這些問題，只有**真的跑過一遍**才會發現。Up-Down-Up 確保：
1. UP 可以執行 ✓
2. DOWN 可以回滾 ✓
3. 回滾後再 UP 還是可以執行 ✓（證明回滾是乾淨的）

---

### Q3: 什麼是「危險操作自動攔截」？會不會誤判？

**A:** 系統會自動偵測以下危險操作：

| 類型 | 危險操作 |
|------|----------|
| 資料刪除 | `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, `db.collection.drop()` |
| 權限變更 | `GRANT`, `REVOKE`, `CREATE USER`, `ALTER USER` |
| 結構變更 | `DROP COLUMN` (可能導致資料丟失) |

**會不會誤判？**

會，而且這是故意的。我們寧可誤判，也不願漏判。

但我們提供了「智慧配對」機制來減少誤判：

```javascript
// 這種情況會自動放行
export const up = async (db) => {
  await db.createCollection('temp_orders'); // CREATE
};
export const down = async (db) => {
  await db.collection('temp_orders').drop(); // DROP ← 自動放行，因為有配對
};
```

如果確實需要執行危險操作，使用 `-- migrate-ignore: drop` 註解並說明原因。

---

### Q4: 什麼是「Sanity Check」？和一般的測試有什麼不同？

**A:** Sanity Check 是**執行後的自動驗證**，確保「執行成功」等於「結果正確」。

**舉個例子**：

你要給所有用戶新增 `phone` 欄位，預設值為空字串：

```javascript
export const up = async (db) => {
  await db.collection('users').updateMany({}, { $set: { phone: '' } });
};
```

執行後，MongoDB 回傳 `{ acknowledged: true }`。成功了？

不一定。可能：
- 有些文件因為 filter 條件問題沒被更新
- 更新過程中有文件被其他程序寫入

**Sanity Check 會驗證結果**：

```javascript
export const postCheck = async ({ db }) => {
  const missing = await db.collection('users').countDocuments({ 
    phone: { $exists: false } 
  });
  
  if (missing > 0) {
    return { 
      success: false, 
      error: `還有 ${missing} 筆資料沒有 phone 欄位` 
    };
  }
  return { success: true };
};
```

如果 `postCheck` 失敗，系統會**自動執行 down() 回滾**。

---

### Q5: 自動回滾不會造成更大的問題嗎？

**A:** 這是很多人的擔心，讓我解釋為什麼自動回滾是安全的：

**前提條件**：
- 你的 migration 已經通過 Up-Down-Up 測試
- 這代表 down migration 是**驗證過可以執行的**

**自動回滾的邏輯**：
1. `postCheck` 失敗 → 發現問題
2. 執行 `down()` → 回到執行前狀態
3. 問題在造成更大影響前被阻止

**如果你還是不放心**：
```bash
# 停用自動回滾，只顯示警告
node src/cli.js up --sanity-check --no-auto-rollback
```

---

### Q6: 我的團隊很忙，沒時間導入新工具。需要多久？

**A:** 我們設計 db-migrate 為**漸進式採用**，從 5 分鐘開始：

| 階段 | 時間 | 做什麼 | 得到什麼 |
|------|------|--------|----------|
| 1 | 5 分鐘 | 對現有遷移執行 `validate` | 立即看到潛在風險報告 |
| 2 | 30 分鐘 | 將 `validate` 加入 CI | 自動攔截危險操作 |
| 3 | 依節奏 | 啟用 Up-Down-Up 測試 | 確保回滾腳本可用 |
| 4 | 依需求 | 加入 Sanity Check | 執行後自動驗證 |

你不需要一次全部導入。先從 `validate` 開始，感受價值後再逐步深入。

---

## 內部常見問題 (Internal FAQ)

### Q7: 這個專案的核心假設是什麼？如果假設錯了會怎樣？

**A:** 我們的核心假設：

| 假設 | 驗證方式 | 如果錯了 |
|------|----------|----------|
| 90% 團隊沒測過 down migration | 訪談 50+ 團隊確認 | 重新評估產品定位 |
| 強制測試可以提高回滾成功率 | 內部試用數據 | 調整測試策略 |
| 開發者願意多花時間寫 Sanity Check | 使用率追蹤 | 簡化 Sanity Check 寫法或提供自動生成 |
| Kubernetes 是主要部署環境 | 市場調查 | 加強其他部署方式支援 |

**最大風險**：開發者覺得「多此一舉」而不願採用。

**緩解策略**：漸進式採用 + 先從 validate 開始展示價值。

---

### Q8: 為什麼不用現有的開源方案？

**A:** 我們評估過：

| 工具 | 為什麼不行 |
|------|------------|
| Flyway | 只有版本控制，沒有安全機制；且以 Java 生態為主 |
| Liquibase | 同上，且設定複雜 |
| migrate-mongo | 只支援 MongoDB，沒有危險操作檢測 |
| sql-migrate | 只支援 SQL，沒有 Up-Down-Up 測試 |

**關鍵差異**：這些工具解決「版本控制」，我們解決「安全機制」。這是不同的問題。

---

### Q9: 開發這個專案需要多少資源？

**A:** 

| 階段 | 時間 | 人力 | 產出 |
|------|------|------|------|
| MVP | 4 週 | 2 人 | CLI + MongoDB/MariaDB 支援 + 基本危險操作檢測 |
| V1.0 | +4 週 | 2 人 | Up-Down-Up 測試 + Sanity Check + Helm Chart |
| V1.5 | +4 週 | 2-3 人 | PostgreSQL 支援 + Web Console |

---

### Q10: 成功指標是什麼？

**A:**

| 指標 | 6 個月目標 | 12 個月目標 |
|------|------------|-------------|
| GitHub Stars | 500 | 2,000 |
| npm 週下載量 | 1,000 | 5,000 |
| 導入團隊數 | 20 | 100 |
| 回滾成功率提升 | +50% | +65% |
| 資料庫相關事故減少 | -50% | -80% |

---

# 附錄 A：問題場景

## 場景一：週五下午的惡夢

**時間**：週五下午 4:30
**情況**：部署新版本，包含一個資料庫 migration

```javascript
// 20250121-add-payment-status.js
export const up = async (db) => {
  await db.collection('orders').updateMany(
    {},
    { $set: { paymentStatus: 'pending' } }
  );
};

export const down = async (db) => {
  await db.collection('orders').updateMany(
    {},
    { $unset: { paymentStatus: '' } }
  );
};
```

**出事了**：部署後發現，舊訂單不應該設為 `pending`，應該保持原狀。需要回滾。

**沒有 db-migrate**：
1. 嘗試執行 down migration → 失敗（因為從沒測過）
2. 發現 down migration 有 bug
3. 修復 bug、重新部署 → 又失敗
4. 手動寫 SQL 修復 → 花了 3 小時
5. 週五晚上 8:00 才下班

**有 db-migrate**：
1. 這個 migration 在 PR 階段就會被標記為「高風險」
2. Code Review 時會被要求加上 Sanity Check
3. 如果真的部署了，postCheck 會發現問題並自動回滾
4. 5 分鐘內解決，準時下班

---

## 場景二：Junior 工程師的失誤

**情況**：Junior 工程師要清理測試資料

```sql
-- 20250121-cleanup-test-data.sql
-- +migrate Up
DROP TABLE test_users;
DROP TABLE test_orders;
DROP TABLE users;  -- 手誤！應該是 test_users

-- +migrate Down
-- 沒寫，因為「反正只是清理」
```

**沒有 db-migrate**：
- Code Review 沒注意到 `DROP TABLE users`
- 部署到 Staging... 沒事（因為 Staging 的 users 本來就是測試資料）
- 部署到 Production... 完蛋了

**有 db-migrate**：
```
❌ VALIDATION FAILED

1. Dangerous operation detected:
   - Line 5: DROP TABLE users (not paired with CREATE)
   - Reason: 'users' was not created in this migration
   
2. Missing down migration:
   - No rollback script provided
   
Use --allow-dangerous to bypass (requires ADMIN approval)
```

部署被阻止，危機解除。

---

## 場景三：Sanity Check 救了一命

**情況**：要給所有用戶加上 `verified` 欄位

```javascript
export const up = async (db) => {
  // 應該用 updateMany，但手誤用了 updateOne
  await db.collection('users').updateOne(
    {},
    { $set: { verified: false } }
  );
};

export const postCheck = async ({ db }) => {
  const total = await db.collection('users').countDocuments();
  const updated = await db.collection('users').countDocuments({ 
    verified: { $exists: true } 
  });
  
  if (updated !== total) {
    return { 
      success: false, 
      error: `只有 ${updated}/${total} 筆資料被更新` 
    };
  }
  return { success: true };
};
```

**執行結果**：
```
✅ Migration executed
🔍 Running post-check...
❌ Post-check failed: 只有 1/10000 筆資料被更新
🔄 Auto-rollback triggered...
✅ Rollback completed
```

問題在造成影響前被自動修復。

---

# 附錄 B：快速開始

```bash
# 1. Clone 專案
git clone https://github.com/i7ppBeer/ddl-migrate.git
cd ddl-migrate

# 2. 安裝依賴
npm install

# 3. 對現有遷移執行驗證（5 分鐘體驗價值）
node src/cli.js -c your-project/config.js validate

# 4. 啟動測試環境並執行完整測試
docker compose up -d
npm test
```

## 更多資源

- 📖 [完整技術文件](./MIGRATION-MANAGEMENT-GUIDE.md)
- 🐳 [本地測試指南](./LOCAL-TEST-GUIDE.md)
- ☸️ [Kubernetes 部署指南](./BUILD-IMAGE-GUIDE.md)

---

*這是一份 Working Backwards 文件。在投入開發資源前，請確認：*
1. *痛點描述是否準確？*
2. *解決方案是否對症？*
3. *FAQ 是否涵蓋主要疑慮？*
4. *成功指標是否合理可衡量？*
