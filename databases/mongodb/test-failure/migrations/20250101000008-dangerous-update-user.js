/**
 * 測試：updateUser 危險操作
 * 預期驗證結果：失敗（修改使用者權限是危險操作）
 */
module.exports = {
  async up(db, client) {
    // 建立正常 collection
    await db.createCollection('audit_logs');
    
    // 危險操作: 更新使用者密碼和角色
    await db.command({
      updateUser: 'appuser',
      pwd: 'newpassword',
      roles: [{ role: 'readWrite', db: 'mydb' }]
    });
  },

  async down(db, client) {
    await db.collection('audit_logs').drop();
  }
};
