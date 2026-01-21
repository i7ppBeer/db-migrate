/**
 * 20250101000002-add-fields-example.js
 * Migration: Add fields and indexes to example collection (新增欄位範本)
 *
 * 說明:
 *   - MongoDB 是 schema-less，新增欄位不需要 ALTER
 *   - 主要用於新增索引、驗證規則、預設值等
 *
 * 執行方式:
 *   docker compose run --rm migrate up -c /app/databases/mongodb/<project>/ddl/config.js
 */

export async function up(db, client) {
  const collectionName = 'example';
  const collection = db.collection(collectionName);
  
  // ============================================
  // 新增索引
  // ============================================
  
  // 複合索引
  await collection.createIndex(
    { name: 1, email: 1 },
    { name: 'idx_name_email' }
  );
  console.log('[DDL] Created index: idx_name_email');
  
  // Text 索引 (全文搜尋)
  await collection.createIndex(
    { name: 'text', description: 'text' },
    { name: 'idx_fulltext', default_language: 'english' }
  );
  console.log('[DDL] Created text index: idx_fulltext');
  
  // ============================================
  // 更新現有文件的預設值 (可選)
  // ============================================
  
  // 為沒有 updatedAt 欄位的文件新增預設值
  const result = await collection.updateMany(
    { updatedAt: { $exists: false } },
    { $set: { updatedAt: new Date() } }
  );
  console.log(`[DDL] Updated ${result.modifiedCount} documents with updatedAt`);
  
  // ============================================
  // 更新驗證規則 (可選)
  // ============================================
  
  // 如需更新 collection 的驗證規則，可使用 collMod
  // await db.command({
  //   collMod: collectionName,
  //   validator: {
  //     $jsonSchema: {
  //       // 新的驗證規則
  //     }
  //   }
  // });
}

export async function down(db, client) {
  const collectionName = 'example';
  const collection = db.collection(collectionName);
  
  // ============================================
  // 刪除索引 (順序與 up 相反)
  // ============================================
  
  try {
    await collection.dropIndex('idx_fulltext');
    console.log('[DDL] Dropped index: idx_fulltext');
  } catch (e) {
    console.log('[DDL] Index idx_fulltext not found, skipping');
  }
  
  try {
    await collection.dropIndex('idx_name_email');
    console.log('[DDL] Dropped index: idx_name_email');
  } catch (e) {
    console.log('[DDL] Index idx_name_email not found, skipping');
  }
  
  // ============================================
  // 移除欄位 (可選，通常不建議)
  // ============================================
  
  // 注意: 移除欄位會造成資料遺失，請謹慎使用
  // await collection.updateMany(
  //   {},
  //   { $unset: { newField: '' } }
  // );
}
