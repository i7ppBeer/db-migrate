# DDL 對正式環境的風險與安全手冊

這篇是這個 repo「DDL 安全」相關工作的總覽與操作手冊：什麼情況會讓正式環境的 DB 卡住、目前有哪些防護已經做了、還缺哪些、跑 DDL 前該檢查什麼、真的出事了要怎麼中止或回滾。細節規則另外寫在專門的文件裡，這裡負責把它們串起來、講清楚彼此的關係。

---

## 1. 會導致線上 DB 卡住的情境

### 1.1 MDL 佇列 FIFO 卡死（本手冊的起源事件）

MariaDB 的 metadata lock（MDL）佇列是 **FIFO**：任何一個 `ALTER TABLE` 排隊等 exclusive 鎖時，後面所有新進來的查詢——包含單純的 `SELECT`——都會被迫排在它後面，不管它們彼此原本相不相容。這件事跟「誰先誰後」無關，兩個方向都會發生：

- **大 DELETE/長交易先到**：ALTER 排隊等它放手，排隊期間新進來的 SELECT 又排在 ALTER 後面 → 全部卡住。
- **ALTER 先到**：DELETE 沒開始執行前就要排隊等 ALTER，一樣全部卡住。

詳細時間軸與四種情境比較，見 Artifact〈[鎖衝突防禦地圖](https://claude.ai/code/artifact/58c23985-91d9-45dd-a137-93819f6f940f)〉。

### 1.2 大表 rebuild 型 ALTER 本身鎖很久

`MODIFY/CHANGE COLUMN`、`ENGINE=`、`CONVERT TO CHARACTER SET` 這類需要整表重建的 ALTER（`ALGORITHM=COPY`），從開始到結束**全程**持有會擋寫入的鎖，時間長短等於重建整張表要多久。跟 1.1 不同：這裡就算完全沒人跟它搶鎖，光是它自己執行的時間，其他查詢就得等。

### 1.3 Online DDL 收尾瞬間撞期

MariaDB 10.0+ 的線上建索引、10.4+ 的 instant 加減欄位，大部分時間允許併發讀寫，**但收尾那一瞬間**需要短暫升級成 exclusive lock。如果剛好有長交易在那一刻還沒 commit，一樣會卡（只是視窗通常很短）。

### 1.4 「跑很久」跟「反覆重試」疊加

Lock Guard（見第 3 節）用短逾時+重試來避免無限期排隊，但**重試是整句重新執行，不是續跑**。如果一個 ALTER 是「跑很久、快結束時才需要搶鎖」的類型（1.3），重試策略反而可能讓它反覆跑到一半就被打斷、重新開始，浪費時間又不會成功。

### 1.5 DDL/DCL 混用

在 DDL 專案裡寫 `CREATE USER`/`GRANT`，或在 DCL 專案裡寫 `ALTER TABLE`，本身雖然不會直接鎖表，但會讓兩種完全不同生命週期的變更（結構變更 vs. 權限管理）混在一起執行，出問題時很難判斷是哪一類操作造成的。

### 1.6 連到錯誤的資料庫/環境

Config 裡的環境變數解析錯誤，導致連線實際指向的資料庫跟預期不同（例如以為是 staging，其實連到 production）。這種狀況下，前面所有的鎖防護都沒有意義——因為你根本是在錯的地方做正確的事。

### 1.7 changelog / checksum 跟磁碟檔案對不上

Migration 檔案被刪除、改名，或 changelog 資料被手動改過，導致工具誤判哪些該執行、哪些已執行——可能重複套用，也可能漏掉。

### 1.8 中斷造成的半套狀態（本次稽核新發現，記錄在此）

`up()` 的執行順序是：**先跑 DDL SQL，成功後才寫入 changelog**。如果在這兩步中間手動中斷（Ctrl+C、程序被殺），SQL 可能已經真的執行成功，但 changelog 沒寫進去——下次 `status`/`up` 還是會把它當成「pending」再跑一次。

這不是這個工具獨有的 bug，是**所有 DDL migration 工具的共同限制**：MariaDB 的 DDL 陳述式會觸發隱性 commit，就算把 SQL 執行跟 changelog 寫入包在同一個 transaction 裡，DDL 本身還是會立刻 commit，兩件事無法真正原子化。

**緩解方式**：UP 區塊盡量寫成冪等的（`CREATE TABLE IF NOT EXISTS`、`ADD COLUMN IF NOT EXISTS` 或先查 `information_schema` 再決定要不要執行），這樣就算重跑一次也不會出錯。

---

## 2. 誤用 `reset` 造成的風險

`reset` 指令（`node src/cli.js reset --yes -c <config>`）**只清空追蹤紀錄，不動實際的表格/collection/資料**。如果在正式環境誤用：

- 清完之後 `up` 會把所有 migration 當成 pending 重跑，但表格早就存在 → 大機率直接失敗（除非全部 UP 都寫成 `IF NOT EXISTS`）。
- 如果剛好有幾個 UP 是冪等的、幾個不是，會出現「跑一半就停」的不一致狀態，比完全失敗更難排查。

**這個指令基本上只該用在會被整個重置的開發/測試資料庫上**——這點已經寫進 `docs/CLI-USAGE-GUIDE.md`，這裡再強調一次因為它直接關聯到「危險操作」的主題。

---

## 3. 目前已建置的防護

| 防護 | 對應情境 | 狀態 | 詳細文件 |
|---|---|---|---|
| 靜態驗證分級（🔴禁止／🟠危險／🟡警告）+ annotation | 1.5（DDL/DCL 混用）、意外的危險操作 | ✅ 已上線 | [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md)、[VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) |
| Lock Guard（session `lock_wait_timeout` + 有限重試） | 1.1、1.2（不改變執行時間，只改變等鎖時間） | ✅ 已上線（`feat/mariadb-lock-guard`） | [LOCK-GUARD.md](./LOCK-GUARD.md) |
| Sanity Check Pre/PostCheck + Auto-Rollback | 執行後驗證結果是否符合預期，不符合就自動回滾 | ✅ 已上線（既有機制） | `src/core/sanity-checker.js` |
| `reset` 指令 | 1.7 的其中一種修復手段（配合完整重置環境） | ✅ 已上線 | 見第 2 節 |
| `validate` 指令的 `[FORCE ALLOWED]`/`[ALLOWED]` 留痕機制 | 任何放行的危險操作都留下審計紀錄，不是靜默通過 | ✅ 已上線 | 同上驗證規則文件 |

**本次稽核也發現兩個現有的邏輯 bug**（會誤判合法的 migration 為錯誤），跟本手冊主題相關但不是「危險操作漏放行」而是「安全操作被誤擋」，細節見 [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md#confirmed-logic-bugs-traced-by-hand-not-inspection-guesses)。

---

## 4. 還沒建置的防護（設計中）

完整規格見 [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md)，這裡只列摘要：

| Gate | 檢查什麼 | 對應情境 | 能不能 `--force` |
|---|---|---|---|
| R0 連線身份 | 連線真的指向 config 說的那個資料庫嗎 | 1.6 | ❌ 不能 |
| R1 changelog 一致性 | changelog/checksum 跟磁碟檔案對得起來嗎 | 1.7 | ❌ 不能 |
| R2 長交易/鎖等待 | 執行前有沒有已經卡住的交易或 MDL 等待 | 1.1 | ✅ 可以 |
| R3 可寫性/複本檢查 | target 是不是唯讀複本 | 1.6 的變體 | 唯讀 → ❌；延遲 → ✅ |
| R4 磁碟/binlog 空間 | 大型 ALTER 會不會把空間耗盡 | 1.2 | ✅ 可以 |

R0/R1 完全沒有覆寫選項，是刻意設計——連錯資料庫、changelog 對不上，都是「有人該去看一眼」的狀況，不是「風險可接受就跳過」的狀況。

---

## 5. 事前檢查清單（跑正式環境 DDL 前）

在 Gate R0-R4 自動化之前，這是目前該手動做的檢查，直接可以複製執行：

```sql
-- 1. 確認連到的是預期的資料庫
SELECT DATABASE();

-- 2. 有沒有長交易還沒 commit
SELECT trx_id, trx_mysql_thread_id,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS duration_sec,
       trx_rows_modified, trx_query
FROM information_schema.INNODB_TRX
WHERE TIMESTAMPDIFF(SECOND, trx_started, NOW()) > 5
ORDER BY duration_sec DESC;

-- 3. 有沒有連線正在等 MDL
SELECT id, user, host, time, state, info
FROM information_schema.PROCESSLIST
WHERE state LIKE '%metadata lock%' OR state LIKE '%Waiting for table%';

-- 4. 這個連線是不是唯讀複本（是的話任何寫入都會失敗，先確認連對節點）
SELECT @@global.read_only, @@global.innodb_read_only;

-- 5.（大表 ALTER 才需要）確認表大小，決定要不要走 pt-online-schema-change
SELECT table_name, table_rows,
       ROUND(data_length/1024/1024, 1) AS data_mb
FROM information_schema.TABLES
WHERE table_schema = DATABASE() AND table_name = '<要改的表>';
```

**判斷標準**：2、3 兩項都回傳空結果，才代表現在適合跑。4 回傳 `1` 就先別跑，去接對節點。5 如果表很大且要做的是 `MODIFY/CHANGE COLUMN`/`ENGINE=`，改用 pt-online-schema-change（見下方連結），不要直接跑。

再跑一次 `node src/cli.js validate -c <config>`，確認沒有未放行的 🔴/🟠 操作，也沒有意外的 `ALTER_TABLE_MODIFY`/`ALTER_TABLE_REBUILD` 警告。

---

## 6. 執行中的防護

MariaDB DDL 專案預設就有 Lock Guard：每句 migration SQL 執行時，連線先設定短逾時（預設 5 秒 `lock_wait_timeout`），卡鎖就重試最多 3 次、每次間隔 2 秒，全部失敗才真正報錯——不會無限期排隊拖累其他查詢。細節、config 選項、跟「DDL 本身要跑很久會不會被誤判失敗」的問題，見 [LOCK-GUARD.md](./LOCK-GUARD.md)。

---

## 7. 事後中止 / 回滾程序

### 7.1 自動層面（已經有的機制）

`up --sanity-check` 執行時，如果 migration 檔案有寫 `PostCheck`，失敗會自動觸發 `down()` 回滾：

- 回滾成功 → 回報失敗原因，資料庫恢復到執行前狀態。
- **回滾也失敗** → 標記為 `critical`，工具會明確印出「需要人工介入」，這種狀況下**不要**再對同一個連線重跑任何指令，先手動確認資料庫實際狀態。

### 7.2 手動中止正在卡住的 migration

1. 先判斷卡住的是**誰**：用第 5 節的查詢 2、3 找出長交易或等鎖的 session。
2. **優先考慮 KILL 造成阻塞的那個交易**（如果它是可以重跑的批次作業），而不是 KILL migration 本身——migration 被強制中斷，容易落入 1.8 講的「SQL 跑了、changelog 沒寫」半套狀態。
   ```sql
   KILL <thread_id>;  -- 對應第 5 節查詢 2、3 找到的 trx_mysql_thread_id / id
   ```
3. 如果真的必須中止 migration 本身（例如它自己卡死、判斷錯誤），中斷後**先檢查實際 DB 狀態**再決定下一步：
   ```bash
   node src/cli.js status -c <config>
   ```
   如果狀態顯示 pending 但你懷疑 SQL 其實已經跑過（看 `information_schema` 確認該有的表/欄位是否已存在），**不要**直接重跑 `up`——先手動核對，必要時用 `baseline` 手動標記為已套用，或修正 migration 讓它冪等後再跑。

### 7.3 造成阻塞的是別人（不是 migration 本身）

如果卡住 migration 的是別的應用程式的長交易（就是本手冊起源的那個情境）：

- 找出該交易的來源（`trx_query`、`host`），評估能不能請對方 commit/rollback，而不是直接 KILL 別人的交易——除非已確認那是可以安全中斷的批次作業。
- 批次作業（大 DELETE/UPDATE）本身應該分批 commit、自己設定合理的 `innodb_lock_wait_timeout`，這是應用團隊的責任，不在 db-migrate 的控制範圍內，但值得在这次事件后一并跟对方团队沟通。

---

## 8. 怎麼知道這些防護是有效的（原理驗證現況）

誠實列出目前的驗證程度，不要照單全收：

| 項目 | 驗證方式 | 狀態 |
|---|---|---|
| Lock Guard 的程式邏輯 | 逐行對照原始碼 + 6 個 mock 單元測試 | ✅ 已驗證 |
| Lock Guard 在真實 MariaDB 上的行為（3 個 e2e 情境） | `test/integration.test.js`，邏輯已 review | ⚠️ 尚未實際跑過（此環境沒有 Docker/MariaDB） |
| 驗證規則的分級/annotation 機制 | 對照原始碼逐條核對 + 實際 CLI 執行截圖 | ✅ 已驗證 |
| FK / orphan-drop 兩個邏輯 bug | 逐步推演 + 具體 SQL 反例 | ✅ 已驗證是真的 bug，尚未修復 |
| Runtime Gate R0-R4 | 純設計文件 | ❌ 完全未實作，無從驗證 |
| `reset` 指令 | 13 個 mock 單元測試 | ✅ 已驗證邏輯；未對真實 DB 測過 |

完整的測試缺口清單見 [TESTING-GUIDE.md](./TESTING-GUIDE.md#known-test-gaps-audited-2026-09-10) 的「Known test gaps」章節。

---

## 相關文件索引

- [鎖衝突防禦地圖](https://claude.ai/code/artifact/58c23985-91d9-45dd-a137-93819f6f940f)（Artifact）— 四種鎖衝突情境的時間軸圖解
- [LOCK-GUARD.md](./LOCK-GUARD.md) — Lock Guard 的完整規格
- [RUNTIME-GATE-PLAN.md](./RUNTIME-GATE-PLAN.md) — Gate R0-R6 完整設計
- [VALIDATION-RULES-MARIADB.md](./VALIDATION-RULES-MARIADB.md) / [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) — 驗證規則詳細表
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) — 測試涵蓋範圍與已知缺口
- [CLI-USAGE-GUIDE.md](./CLI-USAGE-GUIDE.md) — `reset`、`baseline` 等指令的操作細節
