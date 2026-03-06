/**
 * R__00_default_users.js
 * DCL Repeatable Migration: Default Service Account (公版範本)
 * 
 * ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
 * ⚠️ 使用 usersInfo 檢查 + createUser/updateUser 模式確保冪等性
 *
 * 說明:
 *   - 此帳號為基本服務帳號範本
 *   - 請依實際需求修改資料庫名稱和權限
 *
 * 執行方式:
 *   docker compose run --rm migrate dcl -c /app/databases/mongodb/<project>/dcl/config.js
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  const targetDb = 'your_database';  // 請修改為實際資料庫名稱
  
  // ============================================
  // Default Service Account
  // ============================================
  
  const username = 'app_default';
  const password = 'CHANGE_ME_ON_FIRST_LOGIN';  // 請修改密碼
  
  try {
    const users = await adminDb.command({ usersInfo: username });
    
    if (users.users.length === 0) {
      // 建立新使用者
      await adminDb.command({
        createUser: username,
        pwd: password,
        roles: [
          { role: 'read', db: targetDb }  // 基本唯讀權限
        ]
      });
      console.log(`[DCL] Created ${username}`);
      return { passwordSet: true };
    } else {
      // 使用者已存在，更新角色 (冪等)，密碼不動
      await adminDb.command({
        updateUser: username,
        roles: [
          { role: 'read', db: targetDb }
        ]
      });
      console.log(`[DCL] Updated ${username} roles`);
      return { passwordSet: false };
    }
  } catch (error) {
    console.error(`[DCL] Error managing ${username}:`, error.message);
    throw error;
  }
}

// DCL repeatable migrations 不需要 down
export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
