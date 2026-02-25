/**
 * 混合測試：多種管理員危險操作
 * 預期驗證結果：失敗（包含多種危險指令）
 */
export async function up(db, client) {
  // 危險操作1: 建立使用者
  await db.command({
    createUser: 'admin',
    pwd: 'password123',
    roles: [{ role: 'root', db: 'admin' }]
  });

  // 危險操作2: 授權角色
  await db.command({
    grantRolesToUser: 'admin',
    roles: ['dbAdmin']
  });

  // 危險操作3: 撤銷角色
  await db.command({
    revokeRolesFromUser: 'testuser',
    roles: ['read']
  });
}

export async function down(db, client) {
  await db.command({
    dropUser: 'admin'
  });
}
