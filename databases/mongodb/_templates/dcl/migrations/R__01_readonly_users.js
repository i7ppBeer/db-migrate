/**
 * R__01_readonly_users.js
 * DCL Repeatable Migration: Read-Only Users (公版範本)
 *
 * ⚠️ 重要: DCL 腳本必須是 IDEMPOTENT (可重複執行)
 *
 * 用途:
 *   - 報表查詢
 *   - 資料分析
 *   - 監控系統
 *
 * 執行方式:
 *   docker compose run --rm migrate dcl -c /app/databases/mongodb/<project>/dcl/config.js
 */

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // ============================================
  // Read-Only User
  // ============================================
  
  const username = 'app_readonly';
  const password = 'CHANGE_ME_ON_FIRST_LOGIN';  // 請修改密碼
  const targetDatabases = ['your_database'];     // 請修改為實際資料庫名稱
  
  // 建立角色陣列
  const roles = targetDatabases.map(dbName => ({
    role: 'read',
    db: dbName
  }));
  
  try {
    const users = await adminDb.command({ usersInfo: username });
    
    if (users.users.length === 0) {
      // 建立新使用者
      await adminDb.command({
        createUser: username,
        pwd: password,
        roles: roles
      });
      console.log(`[DCL] Created ${username}`);
    } else {
      // 使用者已存在，更新角色 (冪等)
      await adminDb.command({
        updateUser: username,
        roles: roles
      });
      console.log(`[DCL] Updated ${username} roles`);
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
