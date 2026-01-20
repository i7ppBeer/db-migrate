/**
 * 混合測試：危險的資料庫層級操作
 * 預期驗證結果：失敗（包含 dropDatabase 和其他危險操作）
 */
module.exports = {
  async up(db, client) {
    // 建立 collection
    await db.createCollection('temp_data');
    
    // 插入一些資料
    await db.collection('temp_data').insertMany([
      { name: 'test1' },
      { name: 'test2' }
    ]);

    // 危險操作: 關閉伺服器
    // await db.admin().command({ shutdown: 1 });
    
    // 危險操作: dropDatabase 在正常程式碼中
    const adminDb = client.db('old_database');
    await adminDb.dropDatabase();
  },

  async down(db, client) {
    await db.collection('temp_data').drop();
  }
};
