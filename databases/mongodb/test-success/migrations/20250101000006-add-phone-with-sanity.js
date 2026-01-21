/**
 * Migration: Add phone field to users collection (with Sanity Check)
 * Type: DDL (Data Definition Language)
 * 
 * This migration demonstrates the Sanity Check feature:
 * - preCheck: Validates preconditions before migration
 * - postCheck: Validates results after migration (Sanity Check)
 * - Auto-rollback if postCheck fails
 */

import { MongoDBChecks } from '../src/core/sanity-checker.js';

/**
 * Pre-Check: Validate preconditions before migration
 * @param {Object} context - { db, client, helpers }
 * @returns {Promise<{success: boolean, error?: string, details?: string[]}>}
 */
export async function preCheck({ db }) {
  const details = [];
  
  // Check if users collection exists
  const collectionExists = await MongoDBChecks.collectionExists(db, 'users');
  if (!collectionExists) {
    return {
      success: false,
      error: 'Collection "users" does not exist. Run create-users migration first.'
    };
  }
  details.push('✓ Collection "users" exists');
  
  // Check if phone field already exists
  const hasPhone = await MongoDBChecks.hasField(db, 'users', 'phone');
  if (hasPhone) {
    return {
      success: false,
      error: 'Field "phone" already exists in users collection. Migration may have been applied.'
    };
  }
  details.push('✓ Field "phone" does not exist yet');
  
  return { success: true, details };
}

/**
 * Up Migration: Add phone field to all users
 */
export async function up(db, client) {
  // Add phone fields with default values
  await db.collection('users').updateMany(
    { phone: { $exists: false } },
    { 
      $set: { 
        phone: '',
        phoneVerified: false,
        phoneVerifiedAt: null
      } 
    }
  );
  
  // Create sparse index on phone (only indexes documents with phone value)
  await db.collection('users').createIndex(
    { phone: 1 },
    { 
      sparse: true,
      name: 'idx_users_phone'
    }
  );
  
  console.log('✅ Added phone field and created index');
}

/**
 * Post-Check (Sanity Check): Validate migration results
 * @param {Object} context - { db, client, helpers }
 * @returns {Promise<{success: boolean, error?: string, details?: string[]}>}
 */
export async function postCheck({ db }) {
  const details = [];
  
  // Verify all users have phone field
  const missingPhone = await db.collection('users').countDocuments({
    phone: { $exists: false }
  });
  
  if (missingPhone > 0) {
    return {
      success: false,
      error: `${missingPhone} users are missing the phone field`
    };
  }
  details.push('✓ All users have phone field');
  
  // Verify index was created
  const indexExists = await MongoDBChecks.indexExists(db, 'users', 'idx_users_phone');
  if (!indexExists) {
    return {
      success: false,
      error: 'Index "idx_users_phone" was not created'
    };
  }
  details.push('✓ Index "idx_users_phone" exists');
  
  return { success: true, details };
}

/**
 * Down Migration: Remove phone field from all users
 */
export async function down(db, client) {
  // Drop the phone index first
  try {
    await db.collection('users').dropIndex('idx_users_phone');
  } catch (err) {
    // Index might not exist
    console.log('Index idx_users_phone not found, skipping drop');
  }
  
  // Remove phone fields from all users
  await db.collection('users').updateMany(
    {},
    { 
      $unset: { 
        phone: '',
        phoneVerified: '',
        phoneVerifiedAt: ''
      } 
    }
  );
  
  console.log('✅ Removed phone field and dropped index');
}
