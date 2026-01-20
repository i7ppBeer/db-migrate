/**
 * 測試：角色管理危險操作
 * 預期驗證結果：失敗（角色管理是危險操作）
 */
module.exports = {
  async up(db, client) {
    // 建立正常 collection
    await db.createCollection('settings');
    
    // 危險操作: 建立自訂角色
    await db.command({
      createRole: 'superAdmin',
      privileges: [
        { resource: { db: '', collection: '' }, actions: ['anyAction'] }
      ],
      roles: []
    });

    // 危險操作: 授權角色給使用者
    await db.command({
      grantRolesToUser: 'developer',
      roles: ['superAdmin']
    });
  },

  async down(db, client) {
    // 危險操作: 刪除角色
    await db.command({
      dropRole: 'superAdmin'
    });
    
    await db.collection('settings').drop();
  }
};
