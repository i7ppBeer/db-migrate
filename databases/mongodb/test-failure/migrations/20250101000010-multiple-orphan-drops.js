/**
 * 測試：多個孤立 drop 操作
 * 預期驗證結果：失敗（drop 了未在此 migration 建立的 collections）
 */
module.exports = {
  async up(db, client) {
    // 只建立一個 collection
    await db.createCollection('new_collection');
    
    // 但 drop 了多個其他 collections（孤立 drop）
    await db.collection('legacy_users').drop();
    await db.collection('old_products').drop();
    await db.collection('deprecated_orders').drop();
  },

  async down(db, client) {
    // 這裡 drop 自己建立的是 OK 的
    await db.collection('new_collection').drop();
  }
};
