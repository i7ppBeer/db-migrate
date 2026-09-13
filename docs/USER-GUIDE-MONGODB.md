# MongoDB DDL/DCL Migration Guide

> ⚠️ **Not fully verified (2026-09-11 audit)**: This document was written in the same batch as `MIGRATION-MANAGEMENT-GUIDE.md`, which has already been confirmed outdated. A keyword spot-check found no broken flags/code, but there was no line-by-line comparison against the source code — this is not "verified correct," only "no obvious errors found in the sample." For rule details, treat [VALIDATION-RULES-MONGODB.md](./VALIDATION-RULES-MONGODB.md) as authoritative.

> This guide explains how to write DDL (Data Definition Language) and DCL (Data Control Language) migration files for MongoDB.

---

## 📋 Table of Contents

1. [File Types](#1-file-types)
2. [Versioned vs Repeatable Syntax Comparison](#2-versioned-vs-repeatable-syntax-comparison)
3. [Migration File Structure](#3-migration-file-structure)
4. [Dangerous Command List](#4-dangerous-command-list)
5. [How to Allow Dangerous Commands](#5-how-to-allow-dangerous-commands)
6. [Sanity Check Mechanism](#6-sanity-check-mechanism)
7. [Docker Environment Setup and CLI Usage](#7-docker-environment-setup-and-cli-usage)
8. [Scenario Examples](#8-scenario-examples)

---

## 1. File Types

### DDL (Versioned Migration)
- **Purpose**: Schema changes (creating collections, indexes, validation)
- **File name format**: `YYYYMMDDHHMMSS-description.js`
- **Characteristics**: Each file runs exactly once, in version order
- **Example**: `20250101000001-create-users.js`

### DCL (Repeatable Migration)
- **Purpose**: Permission management (users, roles, grants)
- **File name format**: `R__NNN_description.js`
- **Characteristics**: Re-run whenever the checksum changes; must be idempotent
- **Example**: `R__001_create_app_user.js`

---

## 2. Versioned vs Repeatable Syntax Comparison

### 📁 Versioned (DDL) - One-time Execution

| Operation Type | Syntax Example | Notes |
|---------|---------|------|
| Create collection | `db.createCollection('users')` | ✅ Standard usage |
| Create index | `db.collection('users').createIndex({email: 1})` | ✅ Standard usage |
| Create unique index | `createIndex({email: 1}, {unique: true})` | ✅ Standard usage |
| Create compound index | `createIndex({status: 1, createdAt: -1})` | ✅ Standard usage |
| Set schema validation | `db.command({collMod: ...})` | ✅ Standard usage |
| Drop collection | `db.collection('xxx').drop()` | ⚠️ Needs a matching down() |
| Drop index | `db.collection('xxx').dropIndex()` | ⚠️ Dangerous operation |
| Insert seed data | `db.collection('xxx').insertMany()` | ✅ Standard usage |

**File structure:**
```javascript
export async function up(db, client) {
  await db.createCollection('users');
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, name: 'idx_users_email' }
  );
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### 📁 Repeatable (DCL) - Repeatable Execution

| Operation Type | Syntax Example | Notes |
|---------|---------|------|
| Create user | `db.command({createUser: ...})` | ✅ Must check existence first |
| Update user | `db.command({updateUser: ...})` | ✅ Naturally idempotent |
| Drop user | `db.command({dropUser: ...})` | ✅ Must check existence first |
| Create role | `db.command({createRole: ...})` | ✅ Must check existence first |
| Update role | `db.command({updateRole: ...})` | ✅ Naturally idempotent |
| Grant role | `db.command({grantRolesToUser: ...})` | ✅ Naturally idempotent |
| Revoke role | `db.command({revokeRolesFromUser: ...})` | ✅ Naturally idempotent |

**File structure:**
```javascript
// @description: Application users management
// @type: dcl
// @allow-dangerous: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // Check if user exists
  const users = await adminDb.command({ usersInfo: 'app_readonly' });
  
  if (users.users.length === 0) {
    await adminDb.command({
      createUser: 'app_readonly',
      pwd: 'password',
      roles: [{ role: 'read', db: 'mydb' }]
    });
  } else {
    await adminDb.command({
      updateUser: 'app_readonly',
      roles: [{ role: 'read', db: 'mydb' }]
    });
  }
}

export async function down(db, client) {
  console.log('DCL migrations do not support rollback');
}
```

---

## 3. Migration File Structure

### 3.1 Full File Structure Diagram

#### MongoDB Migration File Structure (.js)

**📄 ANNOTATION block** *(optional)*
> Metadata configured via `//` comments

```javascript
// @description: Describes the purpose of this migration
// @allow-dangerous: true
```

---

**🔵 UP function** *(required)*
> `export async function up(db, client) { ... }`

Contains the following sub-blocks:

| Block | Syntax | Required | Description |
|------|------|--------|------|
| 🟡 **PreCheck** | `// ══ PreCheck ══` + throw Error | Optional | State check before execution |
| 🟢 **Main logic** | `// ══ Main Migration ══` | Required | The actual DDL operations to run |
| 🟡 **PostCheck** | `// ══ PostCheck ══` + throw Error | Optional | Result validation after execution |

**PreCheck example:**
```javascript
// ══ PreCheck ══
const exists = await db.listCollections({name: 'users'}).toArray();
if (exists.length === 0) throw new Error('PreCheck failed: users collection not found');
```

**Main logic example:**
```javascript
// ══ Main Migration ══
await db.collection('users').createIndex({email: 1});
await db.collection('users').updateMany(...);
```

**PostCheck example:**
```javascript
// ══ PostCheck ══
const indexes = await db.collection('users').indexes();
if (!indexes.find(i => i.name === 'idx_email')) {
  throw new Error('PostCheck failed: index not created');
}
```

---

**🔴 DOWN function** *(recommended)*
> `export async function down(db, client) { ... }`

```javascript
await db.collection('users').dropIndex('idx_email');
await db.collection('users').drop();
```

---

#### Full Example Structure

```javascript
// @description: ...              // ANNOTATION block
// @allow-dangerous: true

export async function up(db, client) {   // UP function starts
  
  // ══ PreCheck ══               // PreCheck starts
  const exists = await db.listCollections({name: 'users'}).toArray();
  if (exists.length === 0) throw new Error('PreCheck failed');
  
  // ══ Main Migration ══         // Main logic
  await db.createCollection('orders');
  await db.collection('orders').createIndex({userId: 1});
  
  // ══ PostCheck ══              // PostCheck starts
  const indexes = await db.collection('orders').indexes();
  if (!indexes.find(i => i.name === 'userId_1')) {
    throw new Error('PostCheck failed');
  }
}

export async function down(db, client) { // DOWN function starts
  await db.collection('orders').drop();
}
```

### 3.2 Section Descriptions

| Block | Syntax | Required | Purpose |
|------|------|--------|------|
| **up()** | `export async function up(db, client)` | ✅ Required | Defines the "forward migration" logic |
| **down()** | `export async function down(db, client)` | ⚠️ Recommended | Defines the "rollback" logic |
| **PreCheck** | Check code at the start of up() | ❌ Optional | State check before execution |
| **PostCheck** | Validation code at the end of up() | ❌ Optional | Result validation after execution |

### 3.3 Execution Flow

![MongoDB Execution Flow](images/mongodb-execution-flow.drawio.svg)

> 💡 **Tip**: This diagram can be edited directly using the [Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio) extension for VS Code.

### 3.4 Basic Example (up/down only)

```javascript
export async function up(db, client) {
  // Create the collection
  await db.createCollection('users');
  
  // Create indexes
  await db.collection('users').createIndex(
    { email: 1 },
    { unique: true, name: 'uk_users_email' }
  );
  
  await db.collection('users').createIndex(
    { createdAt: -1 },
    { name: 'idx_users_createdAt' }
  );
}

export async function down(db, client) {
  await db.collection('users').drop();
}
```

### 3.5 Full Example (with PreCheck/PostCheck)

```javascript
/**
 * Add a phone field to all users
 * @description: Add phone field to users collection
 * @allow-dangerous: true
 */

export async function up(db, client) {
  const collection = db.collection('users');
  
  // ═══════════════════════════════════════════════════════════════
  // PreCheck: preliminary checks
  // ═══════════════════════════════════════════════════════════════
  
  // Confirm the users collection exists
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // Confirm the phone field doesn't already exist (avoid re-running)
  const existingDoc = await collection.findOne({ phone: { $exists: true } });
  if (existingDoc) {
    console.log('phone field already exists, skipping migration');
    return; // Idempotency: skip if already applied
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Main Migration: main logic
  // ═══════════════════════════════════════════════════════════════
  
  // Add the phone field to all documents
  const result = await collection.updateMany(
    { phone: { $exists: false } },
    { $set: { phone: null, updatedAt: new Date() } }
  );
  console.log(`Updated ${result.modifiedCount} documents`);
  
  // Create index
  await collection.createIndex(
    { phone: 1 },
    { name: 'idx_users_phone', sparse: true }
  );
  
  // ═══════════════════════════════════════════════════════════════
  // PostCheck: post-execution validation
  // ═══════════════════════════════════════════════════════════════
  
  // Confirm all documents have the phone field
  const missingPhone = await collection.countDocuments({ phone: { $exists: false } });
  if (missingPhone > 0) {
    throw new Error(`PostCheck failed: ${missingPhone} documents still missing phone field`);
  }
  
  // Confirm the index was created
  const indexes = await collection.indexes();
  const phoneIndex = indexes.find(idx => idx.name === 'idx_users_phone');
  if (!phoneIndex) {
    throw new Error('PostCheck failed: idx_users_phone index not created');
  }
  
  console.log('Migration completed successfully');
}

export async function down(db, client) {
  const collection = db.collection('users');
  
  // Drop the index
  await collection.dropIndex('idx_users_phone').catch(() => {});
  
  // Remove the phone field
  await collection.updateMany(
    {},
    { $unset: { phone: '' } }
  );
}
```

### 3.6 Schema Validation Example

```javascript
/**
 * Configure schema validation for the products collection
 */

export async function up(db, client) {
  // ═══════════════════════════════════════════════════════════════
  // PreCheck
  // ═══════════════════════════════════════════════════════════════
  
  // Confirm the collection exists
  const collections = await db.listCollections({ name: 'products' }).toArray();
  if (collections.length === 0) {
    // Create it if it doesn't exist
    await db.createCollection('products');
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Main Migration: apply schema validation
  // ═══════════════════════════════════════════════════════════════
  
  await db.command({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            minLength: 1,
            description: 'Product name is required'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0,
            description: 'Price must be a positive number'
          },
          category: {
            bsonType: 'string'
          },
          stock: {
            bsonType: 'int',
            minimum: 0
          }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'warn'
  });
  
  // ═══════════════════════════════════════════════════════════════
  // PostCheck
  // ═══════════════════════════════════════════════════════════════
  
  const collInfo = await db.listCollections({ name: 'products' }).toArray();
  if (!collInfo[0]?.options?.validator) {
    throw new Error('PostCheck failed: Schema validation not applied');
  }
}

export async function down(db, client) {
  // Remove schema validation
  await db.command({
    collMod: 'products',
    validator: {},
    validationLevel: 'off'
  });
}
```

### 3.7 DCL (Repeatable) Example

```javascript
/**
 * Create application users
 * @description: Create application database users
 * @type: dcl
 * @allow-dangerous: true
 */

// Note: DCL files also need up() and down() functions,
// but down() usually just logs and does not actually roll back

export async function up(db, client) {
  const adminDb = client.db('admin');
  
  // ═══════════════════════════════════════════════════════════════
  // Create app_user (read/write permission)
  // ═══════════════════════════════════════════════════════════════
  
  try {
    // Try to create the user
    await adminDb.command({
      createUser: 'app_user',
      pwd: 'secure_password_here',
      roles: [
        { role: 'readWrite', db: 'mydb' }
      ]
    });
    console.log('Created user: app_user');
  } catch (error) {
    if (error.code === 51003) {
      // User already exists, update its roles
      await adminDb.command({
        updateUser: 'app_user',
        roles: [
          { role: 'readWrite', db: 'mydb' }
        ]
      });
      console.log('Updated user: app_user');
    } else {
      throw error;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // Create readonly_user (read-only permission)
  // ═══════════════════════════════════════════════════════════════
  
  try {
    await adminDb.command({
      createUser: 'readonly_user',
      pwd: 'readonly_password_here',
      roles: [
        { role: 'read', db: 'mydb' }
      ]
    });
    console.log('Created user: readonly_user');
  } catch (error) {
    if (error.code === 51003) {
      await adminDb.command({
        updateUser: 'readonly_user',
        roles: [
          { role: 'read', db: 'mydb' }
        ]
      });
      console.log('Updated user: readonly_user');
    } else {
      throw error;
    }
  }
}

export async function down(db, client) {
  // DCL typically does not support rollback
  console.log('DCL migrations typically do not support rollback');
  console.log('To remove users, create a new migration');
}
```

### 3.8 Key Rules Summary

| Rule | Description |
|------|------|
| `export async function up(db, client)` | **Required**, defines the forward migration logic |
| `export async function down(db, client)` | **Recommended**, defines the rollback logic |
| PreCheck | Write checks at the **start** of up(); `throw new Error()` on failure |
| PostCheck | Write validation at the **end** of up(); `throw new Error()` on failure |
| Idempotency | Check whether it has already run, and `return` early if so |
| Parameter `db` | The current database instance |
| Parameter `client` | The MongoDB client, usable to access other databases, e.g. `client.db('admin')` |
| DCL files | Also need up/down functions, but down usually just logs |

---

## 4. Dangerous Command List

### 🔴 Absolutely Forbidden - Requires `--allow-forbidden`

| Code | Syntax | Risk |
|-----|------|---------|
| `DROP_DATABASE` | `db.dropDatabase()` | Deletes the entire database |
| `DROP_DATABASE_CMD` | `{ dropDatabase: 1 }` | Deletes the entire database |
| `CREATE_USER` | `db.createUser()` | Should be managed in a DCL project |
| `CREATE_USER_CMD` | `{ createUser: ... }` | Should be managed in a DCL project |
| `DROP_USER` | `db.dropUser()` | Should be managed in a DCL project |
| `DROP_USER_CMD` | `{ dropUser: ... }` | Should be managed in a DCL project |
| `UPDATE_USER` | `db.updateUser()` | Should be managed in a DCL project |
| `UPDATE_USER_CMD` | `{ updateUser: ... }` | Should be managed in a DCL project |
| `GRANT_ROLES` | `db.grantRolesToUser()` | Should be managed in a DCL project |
| `REVOKE_ROLES` | `db.revokeRolesFromUser()` | Should be managed in a DCL project |
| `CREATE_ROLE` | `db.createRole()` | Should be managed in a DCL project |
| `DROP_ROLE` | `db.dropRole()` | Should be managed in a DCL project |
| `SHUTDOWN` | `{ shutdown: 1 }` | Shuts down the database |
| `REPL_RECONFIG` | `{ replSetReconfig: ... }` | Changes the replica set configuration |
| `SET_PARAMETER` | `{ setParameter: ... }` | Changes system parameters |

### 🟠 Dangerous Operations - Requires `--allow-dangerous` or `@allow-dangerous`

| Code | Syntax | Risk | Recommendation |
|-----|------|---------|------|
| `DROP_COLLECTION` | `.drop()` | Deletes the entire collection | Confirm a backup exists |
| `DELETE_ALL` | `.deleteMany({})` | Deletes all documents | Add a query filter |
| `REMOVE_ALL` | `.remove({})` | Deletes all documents | Use deleteMany with a filter |
| `UPDATE_ALL` | `.updateMany({}, ...)` | Updates all documents | Add a query filter |
| `REPLACE_ONE` | `.replaceOne()` | Fully replaces a document | Use updateOne + $set |
| `DROP_INDEX` | `.dropIndex()` | Affects query performance | Confirm no query relies on it |
| `DROP_INDEXES` | `.dropIndexes()` | Drops all indexes | Very dangerous |
| `RENAME_FIELD` | `{ $rename: ... }` | Breaks the application | Confirm references were updated |
| `UNSET_FIELD` | `{ $unset: ... }` | Permanently removes a field | Confirm the field is unused |
| `RENAME_COLLECTION` | `.renameCollection()` | Breaks the application | Confirm references were updated |
| `VALIDATION_ERROR` | `validationAction: "error"` | Writes will fail | Test with "warn" first |
| `VALIDATION_STRICT` | `validationLevel: "strict"` | Validates all documents | Confirm data conforms |

### 🟡 Warnings - Does not block, but flags for attention

| Syntax | Warning |
|------|---------|
| `.createIndex()` | May take a long time on a large collection |
| `background: false` | Blocks operations |
| `.aggregate()` | May consume significant resources on large datasets |
| `$lookup` | May cause performance issues; confirm proper indexes exist |
| `sparse: true` | Excludes documents with null values |
| `expireAfterSeconds` | A TTL index automatically deletes expired documents |
| `.deleteMany()` | May affect a large amount of data |
| `.updateMany()` | May affect a large amount of data |

---

## 5. How to Allow Dangerous Commands

### Method 1: Add an Annotation in the File (Recommended)

```javascript
// @description: Data cleanup script
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL

export async function up(db, client) {
  // Create the temp collection first so this isn't an orphan drop
  await db.createCollection('temp_data').catch(() => {});
  
  // Now safe to drop
  await db.collection('temp_data').drop();
  
  // Delete old audit logs
  await db.collection('audit_logs').deleteMany({
    createdAt: { $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
  });
}

export async function down(db, client) {
  console.log('Repeatable migrations do not support rollback');
}
```

### Method 2: CLI Arguments

```bash
# Allow all dangerous operations
docker compose run --rm migrate dcl --validate --allow-dangerous -c <config>

# Allow all forbidden operations (requires team approval)
docker compose run --rm migrate dcl --validate --allow-forbidden -c <config>

# Allow specific operation codes
docker compose run --rm migrate validate --allow DROP_COLLECTION,DELETE_ALL -c <config>
```

### Full Annotation Reference

| Annotation | Value | Description |
|------------|---|------|
| `@allow-dangerous` | `true` / `false` | Allow all dangerous operations |
| `@allow-forbidden` | `true` / `false` | Allow all forbidden operations |
| `@allow` | `CODE1,CODE2,...` | Allow specific operation codes |
| `@description` | Text | Describes this migration |
| `@type` | `maintenance` / `dcl` | Type marker |

---

## 6. Sanity Check Mechanism

Sanity Check provides **Pre-Check** and **Post-Check** mechanisms to ensure the state before and after a migration is correct, and supports **automatic rollback**.

### 6.1 Sanity Check Code Structure

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check: preliminary checks
  // ═══════════════════════════════════════════════════════
  
  // Check whether the collection exists
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // Check whether the field already exists (avoid re-running)
  const existingDoc = await db.collection('users').findOne({ newField: { $exists: true } });
  if (existingDoc) {
    console.log('Field already exists, skipping migration');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: run the main migration
  // ═══════════════════════════════════════════════════════
  
  await db.collection('users').updateMany(
    { newField: { $exists: false } },
    { $set: { newField: 'defaultValue' } }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: post-execution check
  // ═══════════════════════════════════════════════════════
  
  // Confirm all documents have the new field
  const missingCount = await db.collection('users').countDocuments({ 
    newField: { $exists: false } 
  });
  
  if (missingCount > 0) {
    throw new Error(`PostCheck failed: ${missingCount} documents still missing newField`);
  }
}

export async function down(db, client) {
  await db.collection('users').updateMany(
    {},
    { $unset: { newField: '' } }
  );
}
```

### 6.2 Execution Flow

```
┌─────────────────┐
│   Pre-Check     │ ── Fail ──→ Throw Error, stop execution
└────────┬────────┘
         │ Success
         ▼
┌─────────────────┐
│ Execute Migration│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Post-Check    │ ── Fail ──→ Throw Error (can be caught and rolled back by the caller)
└────────┬────────┘
         │ Success
         ▼
    Complete ✅
```

### 6.3 Sanity Check Scenario Examples

#### Example 1: Confirm Collection Exists Before Adding a Field

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check
  // ═══════════════════════════════════════════════════════
  const collections = await db.listCollections({ name: 'products' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: products collection does not exist');
  }
  
  // Confirm the tags field doesn't already exist
  const existingWithTags = await db.collection('products').findOne({ 
    tags: { $exists: true } 
  });
  if (existingWithTags) {
    console.log('tags field already exists, skipping');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration
  // ═══════════════════════════════════════════════════════
  const result = await db.collection('products').updateMany(
    { tags: { $exists: false } },
    { $set: { tags: [], updatedAt: new Date() } }
  );
  console.log(`Updated ${result.modifiedCount} products`);
  
  // Create index
  await db.collection('products').createIndex(
    { tags: 1 },
    { name: 'idx_products_tags' }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check
  // ═══════════════════════════════════════════════════════
  const missingTags = await db.collection('products').countDocuments({ 
    tags: { $exists: false } 
  });
  if (missingTags > 0) {
    throw new Error(`PostCheck failed: ${missingTags} products still missing tags`);
  }
  
  // Confirm the index exists
  const indexes = await db.collection('products').indexes();
  const hasIndex = indexes.some(idx => idx.name === 'idx_products_tags');
  if (!hasIndex) {
    throw new Error('PostCheck failed: idx_products_tags index not created');
  }
}

export async function down(db, client) {
  await db.collection('products').dropIndex('idx_products_tags').catch(() => {});
  await db.collection('products').updateMany({}, { $unset: { tags: '' } });
}
```

#### Example 2: Confirm No Duplicate Values Before Creating an Index

```javascript
export async function up(db, client) {
  const collection = db.collection('users');
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check: confirm there are no duplicate emails
  // ═══════════════════════════════════════════════════════
  const duplicates = await collection.aggregate([
    { $group: { _id: '$email', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 }
  ]).toArray();
  
  if (duplicates.length > 0) {
    const dupEmails = duplicates.map(d => d._id).join(', ');
    throw new Error(`PreCheck failed: Duplicate emails found: ${dupEmails}`);
  }
  
  // Confirm there are no null emails
  const nullEmails = await collection.countDocuments({ 
    $or: [{ email: null }, { email: '' }] 
  });
  if (nullEmails > 0) {
    throw new Error(`PreCheck failed: ${nullEmails} users have null/empty email`);
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: create the unique index
  // ═══════════════════════════════════════════════════════
  await collection.createIndex(
    { email: 1 },
    { unique: true, name: 'idx_users_email_unique' }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: confirm the index was created
  // ═══════════════════════════════════════════════════════
  const indexes = await collection.indexes();
  const uniqueIndex = indexes.find(idx => idx.name === 'idx_users_email_unique');
  
  if (!uniqueIndex) {
    throw new Error('PostCheck failed: Unique index not created');
  }
  
  if (!uniqueIndex.unique) {
    throw new Error('PostCheck failed: Index is not unique');
  }
  
  console.log('Successfully created unique email index');
}

export async function down(db, client) {
  await db.collection('users').dropIndex('idx_users_email_unique');
}
```

#### Example 3: Verify Data Integrity During Migration

```javascript
export async function up(db, client) {
  // ═══════════════════════════════════════════════════════
  // Pre-Check: confirm both source and target are ready
  // ═══════════════════════════════════════════════════════
  
  // Confirm the source collection has data
  const sourceCount = await db.collection('old_orders').countDocuments();
  if (sourceCount === 0) {
    console.log('No data to migrate, skipping');
    return;
  }
  
  // Confirm the target collection exists
  const collections = await db.listCollections({ name: 'new_orders' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: new_orders collection does not exist');
  }
  
  // Record the target count before migration
  const beforeTargetCount = await db.collection('new_orders').countDocuments();
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: migrate data using an aggregation pipeline
  // ═══════════════════════════════════════════════════════
  const pipeline = [
    { $match: { migrated: { $ne: true } } },
    {
      $project: {
        orderId: '$_id',
        customerId: '$customer_id',
        items: '$order_items',
        totalAmount: '$total',
        status: '$order_status',
        createdAt: '$created_at',
        migratedAt: new Date()
      }
    },
    {
      $merge: {
        into: 'new_orders',
        on: 'orderId',
        whenMatched: 'keepExisting',
        whenNotMatched: 'insert'
      }
    }
  ];
  
  await db.collection('old_orders').aggregate(pipeline).toArray();
  
  // Mark as migrated
  await db.collection('old_orders').updateMany(
    { migrated: { $ne: true } },
    { $set: { migrated: true, migratedAt: new Date() } }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: confirm migration completeness
  // ═══════════════════════════════════════════════════════
  
  // Confirm all source data has been marked as migrated
  const unmigrated = await db.collection('old_orders').countDocuments({ 
    migrated: { $ne: true } 
  });
  if (unmigrated > 0) {
    throw new Error(`PostCheck failed: ${unmigrated} orders not migrated`);
  }
  
  // Confirm the target count increased
  const afterTargetCount = await db.collection('new_orders').countDocuments();
  console.log(`Migrated ${afterTargetCount - beforeTargetCount} orders`);
  
  if (afterTargetCount < beforeTargetCount) {
    throw new Error('PostCheck failed: Target collection count decreased!');
  }
}

export async function down(db, client) {
  // Delete the migrated data
  await db.collection('new_orders').deleteMany({ migratedAt: { $exists: true } });
  
  // Reset the migration markers
  await db.collection('old_orders').updateMany(
    { migrated: true },
    { $unset: { migrated: '', migratedAt: '' } }
  );
}
```

#### Example 4: Confirm Data Compatibility Before Changing Schema Validation

```javascript
export async function up(db, client) {
  const collectionName = 'products';
  const collection = db.collection(collectionName);
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check: confirm existing data conforms to the new schema
  // ═══════════════════════════════════════════════════════
  
  // Check for documents missing required fields
  const missingName = await collection.countDocuments({ 
    $or: [{ name: { $exists: false } }, { name: null }, { name: '' }] 
  });
  if (missingName > 0) {
    throw new Error(`PreCheck failed: ${missingName} products missing required 'name' field`);
  }
  
  // Check whether all prices are positive
  const invalidPrice = await collection.countDocuments({ 
    $or: [
      { price: { $exists: false } },
      { price: { $lt: 0 } },
      { price: { $type: 'string' } }
    ] 
  });
  if (invalidPrice > 0) {
    throw new Error(`PreCheck failed: ${invalidPrice} products have invalid price`);
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration: apply strict schema validation
  // ═══════════════════════════════════════════════════════
  await db.command({
    collMod: collectionName,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            minLength: 1,
            description: 'Product name is required'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0,
            description: 'Price must be a positive decimal'
          },
          stock: {
            bsonType: 'int',
            minimum: 0
          }
        }
      }
    },
    validationLevel: 'strict',
    validationAction: 'error'
  });
  
  // ═══════════════════════════════════════════════════════
  // Post-Check: confirm schema validation was applied
  // ═══════════════════════════════════════════════════════
  const collectionInfo = await db.listCollections({ name: collectionName }).toArray();
  const options = collectionInfo[0]?.options;
  
  if (!options?.validator) {
    throw new Error('PostCheck failed: Schema validation not applied');
  }
  
  if (options?.validationLevel !== 'strict') {
    throw new Error('PostCheck failed: validationLevel is not strict');
  }
  
  console.log('Schema validation applied successfully');
}

export async function down(db, client) {
  // Remove schema validation
  await db.command({
    collMod: 'products',
    validator: {},
    validationLevel: 'off'
  });
}
```

#### Example 5: Confirm Field Exists Before Creating a TTL Index

```javascript
export async function up(db, client) {
  const collection = db.collection('sessions');
  
  // ═══════════════════════════════════════════════════════
  // Pre-Check
  // ═══════════════════════════════════════════════════════
  
  // Confirm the collection exists
  const collections = await db.listCollections({ name: 'sessions' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: sessions collection does not exist');
  }
  
  // Confirm the expiresAt field exists and is a Date type
  const sampleDoc = await collection.findOne({ expiresAt: { $exists: true } });
  if (!sampleDoc) {
    throw new Error('PreCheck failed: No documents with expiresAt field found');
  }
  
  if (!(sampleDoc.expiresAt instanceof Date)) {
    throw new Error('PreCheck failed: expiresAt is not a Date type');
  }
  
  // Confirm no TTL index already exists
  const indexes = await collection.indexes();
  const existingTTL = indexes.find(idx => idx.expireAfterSeconds !== undefined);
  if (existingTTL) {
    console.log('TTL index already exists, skipping');
    return;
  }
  
  // ═══════════════════════════════════════════════════════
  // Execute Migration
  // ═══════════════════════════════════════════════════════
  await collection.createIndex(
    { expiresAt: 1 },
    { 
      name: 'idx_sessions_ttl',
      expireAfterSeconds: 0  // Expires at the time specified by expiresAt
    }
  );
  
  // ═══════════════════════════════════════════════════════
  // Post-Check
  // ═══════════════════════════════════════════════════════
  const newIndexes = await collection.indexes();
  const ttlIndex = newIndexes.find(idx => idx.name === 'idx_sessions_ttl');
  
  if (!ttlIndex) {
    throw new Error('PostCheck failed: TTL index not created');
  }
  
  if (ttlIndex.expireAfterSeconds !== 0) {
    throw new Error('PostCheck failed: TTL index has wrong expireAfterSeconds value');
  }
  
  console.log('TTL index created successfully');
}

export async function down(db, client) {
  await db.collection('sessions').dropIndex('idx_sessions_ttl');
}
```

---

## 7. Docker Environment Setup and CLI Usage

### 7.1 Getting the Docker Image

```bash
# Option 1: Pull from a registry (if published)
docker pull your-registry/ddl-migrate:latest

# Option 2: Build locally
git clone https://github.com/your-org/ddl-migrate.git
cd ddl-migrate
docker compose build migrate
```

### 7.2 Local Environment Setup

**Directory structure:**
```
your-project/
├── docker-compose.yml
└── test-fixtures/
    └── mongodb/
        └── your-project/
            ├── ddl/
            │   ├── config.js
            │   └── migrations/
            │       ├── 20250101000001-create-users.js
            │       └── 20250101000002-create-orders.js
            └── dcl/
                ├── config.js
                └── migrations/
                    ├── R__001_app_users.js
                    └── R__002_readonly_users.js
```

**config.js example:**
```javascript
export default {
  type: 'mongodb',
  mongodb: {
    url: process.env.MONGODB_URI || 'mongodb://mongodb:27017',
    databaseName: process.env.MONGODB_DB || 'your_database',
    options: {}
  },
  migrationsDir: './migrations',
  changelogCollection: 'changelog'  // Used for DDL
  // checksumTable: '_dcl_migrations'    // Used for DCL
};
```

### 7.3 Full CLI Command Reference

```bash
# ═══════════════════════════════════════════════════════════
# DDL (Versioned) operations
# ═══════════════════════════════════════════════════════════

# Check status
docker compose run --rm migrate status -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# Run migrations
docker compose run --rm migrate up -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# Dry run (preview)
docker compose run --rm migrate up --dry-run -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# Roll back 1 migration
docker compose run --rm migrate down -n 1 -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# Validate migration files
docker compose run --rm migrate validate -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# Create a new DDL migration file
docker compose run --rm migrate create "add-user-profile" -c /app/test-fixtures/mongodb/your-project/ddl/config.js

# ═══════════════════════════════════════════════════════════
# DCL (Repeatable) operations
# ═══════════════════════════════════════════════════════════

# Check DCL status
docker compose run --rm migrate dcl:status -c /app/test-fixtures/mongodb/your-project/dcl/config.js

# Run DCL (no validation)
docker compose run --rm migrate dcl -c /app/test-fixtures/mongodb/your-project/dcl/config.js

# Run DCL (with validation enabled)
docker compose run --rm migrate dcl --validate -c /app/test-fixtures/mongodb/your-project/dcl/config.js

# Run DCL (allow dangerous operations)
docker compose run --rm migrate dcl --validate --allow-dangerous -c /app/test-fixtures/mongodb/your-project/dcl/config.js

# Dry run (preview)
docker compose run --rm migrate dcl --dry-run -c /app/test-fixtures/mongodb/your-project/dcl/config.js

# Create a new DCL migration file
docker compose run --rm migrate create-dcl "create-app-user" -n 001 -c /app/test-fixtures/mongodb/your-project/dcl/config.js
```

---

## 8. Scenario Examples

### Scenario 1: Create a New Collection and Set Up Indexes (DDL)

**File**: `20250126000001-create-products.js`

```javascript
export async function up(db, client) {
  // Create the collection with schema validation
  await db.createCollection('products', {
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: {
            bsonType: 'string',
            description: 'Product name is required'
          },
          price: {
            bsonType: 'decimal',
            minimum: 0,
            description: 'Price must be a positive number'
          },
          category: {
            bsonType: 'string'
          },
          stock: {
            bsonType: 'int',
            minimum: 0
          },
          isActive: {
            bsonType: 'bool'
          },
          createdAt: {
            bsonType: 'date'
          }
        }
      }
    },
    validationLevel: 'moderate',
    validationAction: 'warn'
  });

  // Create indexes
  const collection = db.collection('products');
  
  await collection.createIndex(
    { name: 'text', category: 'text' },
    { name: 'idx_products_text_search' }
  );
  
  await collection.createIndex(
    { category: 1, createdAt: -1 },
    { name: 'idx_products_category_date' }
  );
  
  await collection.createIndex(
    { isActive: 1 },
    { name: 'idx_products_active', sparse: true }
  );
  
  console.log('Created products collection with indexes');
}

export async function down(db, client) {
  await db.collection('products').drop();
  console.log('Dropped products collection');
}
```

### Scenario 2: Modify an Existing Collection - Add a Field and Index (DDL)

**File**: `20250126000002-add-product-tags.js`

```javascript
export async function up(db, client) {
  const collection = db.collection('products');
  
  // Add the tags field to all existing documents
  await collection.updateMany(
    { tags: { $exists: false } },
    { $set: { tags: [], updatedAt: new Date() } }
  );
  
  // Create a multikey index on tags
  await collection.createIndex(
    { tags: 1 },
    { name: 'idx_products_tags' }
  );
  
  // Update schema validation (optional)
  await db.command({
    collMod: 'products',
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['name', 'price'],
        properties: {
          name: { bsonType: 'string' },
          price: { bsonType: 'decimal', minimum: 0 },
          tags: {
            bsonType: 'array',
            items: { bsonType: 'string' }
          }
        }
      }
    }
  });
  
  console.log('Added tags field and index to products');
}

export async function down(db, client) {
  const collection = db.collection('products');
  
  // Drop the index
  await collection.dropIndex('idx_products_tags');
  
  // Remove the field
  await collection.updateMany(
    {},
    { $unset: { tags: '' } }
  );
  
  console.log('Removed tags field and index from products');
}
```

### Scenario 3: Create Application Users (DCL)

**File**: `R__001_app_users.js`

```javascript
// @description: Application database users
// @type: dcl
// @allow-forbidden: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  const dbName = 'your_database';
  
  // ========================================
  // Read-Only User (for reporting)
  // ========================================
  try {
    const readonlyUsers = await adminDb.command({ 
      usersInfo: { user: 'app_readonly', db: 'admin' } 
    });
    
    if (readonlyUsers.users.length === 0) {
      await adminDb.command({
        createUser: 'app_readonly',
        pwd: process.env.READONLY_PASSWORD || 'readonly_password_here',
        roles: [
          { role: 'read', db: dbName }
        ]
      });
      console.log('[DCL] Created app_readonly user');
    } else {
      await adminDb.command({
        updateUser: 'app_readonly',
        roles: [
          { role: 'read', db: dbName }
        ]
      });
      console.log('[DCL] Updated app_readonly user roles');
    }
  } catch (error) {
    console.error('[DCL] Error managing app_readonly:', error.message);
  }

  // ========================================
  // Read-Write User (for application)
  // ========================================
  try {
    const rwUsers = await adminDb.command({ 
      usersInfo: { user: 'app_readwrite', db: 'admin' } 
    });
    
    if (rwUsers.users.length === 0) {
      await adminDb.command({
        createUser: 'app_readwrite',
        pwd: process.env.READWRITE_PASSWORD || 'readwrite_password_here',
        roles: [
          { role: 'readWrite', db: dbName }
        ]
      });
      console.log('[DCL] Created app_readwrite user');
    } else {
      await adminDb.command({
        updateUser: 'app_readwrite',
        roles: [
          { role: 'readWrite', db: dbName }
        ]
      });
      console.log('[DCL] Updated app_readwrite user roles');
    }
  } catch (error) {
    console.error('[DCL] Error managing app_readwrite:', error.message);
  }
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### Scenario 4: Create Custom Roles (DCL)

**File**: `R__002_custom_roles.js`

```javascript
// @description: Custom application roles
// @type: dcl
// @allow-forbidden: true

export async function up(db, client) {
  const adminDb = client.db('admin');
  const dbName = 'your_database';
  
  // ========================================
  // Custom Role: Product Manager
  // Can manage products but not orders
  // ========================================
  try {
    const roles = await adminDb.command({ 
      rolesInfo: { role: 'productManager', db: 'admin' } 
    });
    
    const roleDefinition = {
      privileges: [
        {
          resource: { db: dbName, collection: 'products' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'categories' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'orders' },
          actions: ['find']  // Read-only for orders
        }
      ],
      roles: []
    };
    
    if (roles.roles.length === 0) {
      await adminDb.command({
        createRole: 'productManager',
        ...roleDefinition
      });
      console.log('[DCL] Created productManager role');
    } else {
      await adminDb.command({
        updateRole: 'productManager',
        ...roleDefinition
      });
      console.log('[DCL] Updated productManager role');
    }
  } catch (error) {
    console.error('[DCL] Error managing productManager role:', error.message);
  }

  // ========================================
  // Custom Role: Order Manager
  // Can manage orders but only read products
  // ========================================
  try {
    const roles = await adminDb.command({ 
      rolesInfo: { role: 'orderManager', db: 'admin' } 
    });
    
    const roleDefinition = {
      privileges: [
        {
          resource: { db: dbName, collection: 'orders' },
          actions: ['find', 'insert', 'update', 'remove']
        },
        {
          resource: { db: dbName, collection: 'products' },
          actions: ['find']  // Read-only for products
        },
        {
          resource: { db: dbName, collection: 'users' },
          actions: ['find']  // Read-only for users
        }
      ],
      roles: []
    };
    
    if (roles.roles.length === 0) {
      await adminDb.command({
        createRole: 'orderManager',
        ...roleDefinition
      });
      console.log('[DCL] Created orderManager role');
    } else {
      await adminDb.command({
        updateRole: 'orderManager',
        ...roleDefinition
      });
      console.log('[DCL] Updated orderManager role');
    }
  } catch (error) {
    console.error('[DCL] Error managing orderManager role:', error.message);
  }
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### Scenario 5: Dangerous Operation - Data Cleanup (DCL)

**File**: `R__010_data_cleanup.js`

```javascript
// @description: Periodic data cleanup job
// @type: maintenance
// @allow-dangerous: true
// @allow: DROP_COLLECTION,DELETE_ALL

export async function up(db, client) {
  console.log('[Cleanup] Starting data cleanup...');
  
  // ========================================
  // 1. Clean up temporary collections
  // ========================================
  // First create the collection so it's not an orphan drop
  await db.createCollection('temp_processing').catch(() => {});
  
  try {
    await db.collection('temp_processing').drop();
    console.log('[Cleanup] Dropped temp_processing collection');
  } catch (error) {
    if (error.code !== 26) { // 26 = NamespaceNotFound
      throw error;
    }
  }

  // ========================================
  // 2. Archive and clean old audit logs (90 days)
  // ========================================
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  
  // Ensure audit_logs_archive exists
  await db.createCollection('audit_logs_archive').catch(() => {});
  
  // Archive old logs
  const oldLogs = await db.collection('audit_logs')
    .find({ createdAt: { $lt: ninetyDaysAgo } })
    .toArray();
  
  if (oldLogs.length > 0) {
    await db.collection('audit_logs_archive').insertMany(oldLogs, {
      ordered: false
    }).catch(() => {}); // Ignore duplicate key errors
    
    // Delete archived logs
    const deleteResult = await db.collection('audit_logs').deleteMany({
      createdAt: { $lt: ninetyDaysAgo }
    });
    
    console.log(`[Cleanup] Archived and deleted ${deleteResult.deletedCount} old audit logs`);
  }

  // ========================================
  // 3. Clean up expired sessions
  // ========================================
  const sessionResult = await db.collection('sessions').deleteMany({
    expiresAt: { $lt: new Date() }
  });
  console.log(`[Cleanup] Deleted ${sessionResult.deletedCount} expired sessions`);

  // ========================================
  // 4. Clean up orphaned files metadata
  // ========================================
  const orphanedFiles = await db.collection('files').deleteMany({
    status: 'pending',
    createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  });
  console.log(`[Cleanup] Deleted ${orphanedFiles.deletedCount} orphaned file records`);
  
  console.log('[Cleanup] Data cleanup completed');
}

export async function down(db, client) {
  console.log('[DCL] Repeatable migrations do not support rollback');
}
```

### Scenario 6: Migration with Sanity Check (DDL)

**File**: `20250126000003-add-user-preferences.js`

```javascript
export async function up(db, client) {
  const collection = db.collection('users');
  
  // Pre-check: Ensure users collection exists
  const collections = await db.listCollections({ name: 'users' }).toArray();
  if (collections.length === 0) {
    throw new Error('PreCheck failed: users collection does not exist');
  }
  
  // Pre-check: Ensure preferences field doesn't exist
  const existingWithPrefs = await collection.findOne({ preferences: { $exists: true } });
  if (existingWithPrefs) {
    console.log('Preferences field already exists, skipping update');
    return;
  }
  
  // Migration: Add preferences field
  const result = await collection.updateMany(
    { preferences: { $exists: false } },
    {
      $set: {
        preferences: {
          theme: 'light',
          notifications: true,
          language: 'en'
        },
        updatedAt: new Date()
      }
    }
  );
  
  console.log(`Updated ${result.modifiedCount} users with default preferences`);
  
  // Post-check: Verify all users have preferences
  const usersWithoutPrefs = await collection.countDocuments({ 
    preferences: { $exists: false } 
  });
  
  if (usersWithoutPrefs > 0) {
    throw new Error(`PostCheck failed: ${usersWithoutPrefs} users still without preferences`);
  }
  
  // Create index for preferences queries
  await collection.createIndex(
    { 'preferences.theme': 1 },
    { name: 'idx_users_preferences_theme', sparse: true }
  );
}

export async function down(db, client) {
  const collection = db.collection('users');
  
  // Remove the index
  await collection.dropIndex('idx_users_preferences_theme').catch(() => {});
  
  // Remove the preferences field
  await collection.updateMany(
    {},
    { $unset: { preferences: '' } }
  );
  
  console.log('Removed preferences field from all users');
}
```

### Scenario 7: Complex Aggregation Pipeline Operation (DDL)

**File**: `20250126000004-create-materialized-view.js`

```javascript
export async function up(db, client) {
  // ========================================
  // Create a materialized view collection
  // for product sales statistics
  // ========================================
  
  // Ensure the view collection exists
  await db.createCollection('product_sales_stats').catch(() => {});
  
  // Create the aggregation pipeline
  const pipeline = [
    {
      $lookup: {
        from: 'products',
        localField: 'productId',
        foreignField: '_id',
        as: 'product'
      }
    },
    {
      $unwind: '$product'
    },
    {
      $group: {
        _id: '$productId',
        productName: { $first: '$product.name' },
        category: { $first: '$product.category' },
        totalSales: { $sum: '$quantity' },
        totalRevenue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } },
        orderCount: { $sum: 1 },
        avgOrderValue: { $avg: { $multiply: ['$quantity', '$unitPrice'] } },
        lastOrderDate: { $max: '$orderDate' }
      }
    },
    {
      $merge: {
        into: 'product_sales_stats',
        on: '_id',
        whenMatched: 'replace',
        whenNotMatched: 'insert'
      }
    }
  ];
  
  // Run initial aggregation
  await db.collection('order_items').aggregate(pipeline).toArray();
  
  // Create indexes on the stats collection
  const statsCollection = db.collection('product_sales_stats');
  
  await statsCollection.createIndex(
    { totalRevenue: -1 },
    { name: 'idx_stats_revenue' }
  );
  
  await statsCollection.createIndex(
    { category: 1, totalSales: -1 },
    { name: 'idx_stats_category_sales' }
  );
  
  console.log('Created product_sales_stats materialized view');
}

export async function down(db, client) {
  await db.collection('product_sales_stats').drop();
  console.log('Dropped product_sales_stats collection');
}
```

---

## 📝 Best Practices

1. **DDL files must always have a down() function** to ensure rollback is possible
2. **DCL files must be idempotent** — check for existence before creating/updating
3. **When creating indexes on large collections**, consider using `{ background: true }` (prior to MongoDB 4.2)
4. **Never hardcode passwords** — use environment variables
5. **Dangerous operations need an explicit annotation** explaining why they're necessary
6. **Use try-catch** to handle possible errors
7. **Add console.log** to record the execution process

---

## 🔗 Related Documents

- [CLI Usage Guide](CLI-USAGE-GUIDE.md)
- [Docker Compose User Guide](DOCKER-COMPOSE-USER-GUIDE.md)
- [Migration Management Guide](MIGRATION-MANAGEMENT-GUIDE.md)
