/**
 * 20250101000001-create-example-collection.js
 * Migration: Create example collection with indexes (DDL 範本)
 *
 * 說明:
 *   - 檔名格式: YYYYMMDDHHMMSS-description.js
 *   - 必須實作 up() 和 down() 函數
 *   - up() 執行升級邏輯
 *   - down() 執行降級/回滾邏輯
 *
 * 執行方式:
 *   docker compose run --rm migrate up -c /app/databases/mongodb/<project>/ddl/config.js
 */

export async function up(db, client) {
  // ============================================
  // 建立 Collection (如果不存在)
  // ============================================
  
  const collectionName = 'example';
  
  // 檢查 collection 是否存在
  const collections = await db.listCollections({ name: collectionName }).toArray();
  
  if (collections.length === 0) {
    // 建立 collection 並設定驗證規則 (可選)
    await db.createCollection(collectionName, {
      validator: {
        $jsonSchema: {
          bsonType: 'object',
          required: ['name', 'status', 'createdAt'],
          properties: {
            name: {
              bsonType: 'string',
              description: 'Name is required and must be a string'
            },
            email: {
              bsonType: 'string',
              pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
              description: 'Email must be a valid email address'
            },
            status: {
              enum: ['active', 'inactive', 'pending'],
              description: 'Status must be one of: active, inactive, pending'
            },
            createdAt: {
              bsonType: 'date',
              description: 'Created timestamp'
            },
            updatedAt: {
              bsonType: 'date',
              description: 'Updated timestamp'
            }
          }
        }
      },
      validationLevel: 'moderate',
      validationAction: 'warn'
    });
    console.log(`[DDL] Created collection: ${collectionName}`);
  }
  
  // ============================================
  // 建立索引
  // ============================================
  
  const collection = db.collection(collectionName);
  
  // 建立唯一索引
  await collection.createIndex(
    { email: 1 },
    { unique: true, sparse: true, name: 'idx_email_unique' }
  );
  console.log('[DDL] Created unique index: idx_email_unique');
  
  // 建立一般索引
  await collection.createIndex(
    { status: 1, createdAt: -1 },
    { name: 'idx_status_created' }
  );
  console.log('[DDL] Created index: idx_status_created');
  
  // 建立 TTL 索引 (可選，用於自動過期)
  // await collection.createIndex(
  //   { expireAt: 1 },
  //   { expireAfterSeconds: 0, name: 'idx_ttl_expire' }
  // );
}

export async function down(db, client) {
  const collectionName = 'example';
  
  // ============================================
  // 刪除索引
  // ============================================
  
  const collection = db.collection(collectionName);
  
  try {
    await collection.dropIndex('idx_status_created');
    console.log('[DDL] Dropped index: idx_status_created');
  } catch (e) {
    console.log('[DDL] Index idx_status_created not found, skipping');
  }
  
  try {
    await collection.dropIndex('idx_email_unique');
    console.log('[DDL] Dropped index: idx_email_unique');
  } catch (e) {
    console.log('[DDL] Index idx_email_unique not found, skipping');
  }
  
  // ============================================
  // 刪除 Collection
  // ============================================
  
  const collections = await db.listCollections({ name: collectionName }).toArray();
  if (collections.length > 0) {
    await db.dropCollection(collectionName);
    console.log(`[DDL] Dropped collection: ${collectionName}`);
  }
}
