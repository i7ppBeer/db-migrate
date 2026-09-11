import { describe, it, expect } from 'vitest';
import { diffSchemaSnapshots, isDiffEmpty } from '../src/core/schema-diff.js';

describe('diffSchemaSnapshots — MariaDB shape (table/columns)', () => {
  it('detects a newly added table', () => {
    const before = [];
    const after = [{ table: 'orders', engine: 'InnoDB', rows: 0, columns: [{ name: 'id', type: 'bigint', nullable: false, key: 'PRI' }] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].table).toBe('orders');
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });

  it('detects a removed table', () => {
    const before = [{ table: 'legacy', engine: 'InnoDB', rows: 0, columns: [] }];
    const after = [];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0].table).toBe('legacy');
  });

  it('detects an added column on an existing table', () => {
    const before = [{ table: 'users', columns: [{ name: 'id', type: 'bigint', nullable: false, key: 'PRI' }] }];
    const after = [{ table: 'users', columns: [
      { name: 'id', type: 'bigint', nullable: false, key: 'PRI' },
      { name: 'last_login_at', type: 'timestamp', nullable: true, key: '' }
    ] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].name).toBe('users');
    expect(diff.changed[0].addedFields).toHaveLength(1);
    expect(diff.changed[0].addedFields[0].name).toBe('last_login_at');
    expect(diff.changed[0].removedFields).toHaveLength(0);
    expect(diff.changed[0].changedFields).toHaveLength(0);
  });

  it('detects a removed column', () => {
    const before = [{ table: 'users', columns: [{ name: 'id', type: 'bigint' }, { name: 'nickname', type: 'varchar(50)' }] }];
    const after = [{ table: 'users', columns: [{ name: 'id', type: 'bigint' }] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.changed[0].removedFields).toHaveLength(1);
    expect(diff.changed[0].removedFields[0].name).toBe('nickname');
  });

  it('detects a changed column type', () => {
    const before = [{ table: 'users', columns: [{ name: 'email', type: 'varchar(255)', nullable: false, key: '' }] }];
    const after = [{ table: 'users', columns: [{ name: 'email', type: 'varchar(320)', nullable: false, key: '' }] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.changed[0].changedFields).toHaveLength(1);
    expect(diff.changed[0].changedFields[0]).toMatchObject({
      name: 'email',
      before: { type: 'varchar(255)' },
      after: { type: 'varchar(320)' }
    });
  });

  it('detects a changed nullable flag even when type is identical', () => {
    const before = [{ table: 'users', columns: [{ name: 'bio', type: 'text', nullable: true, key: '' }] }];
    const after = [{ table: 'users', columns: [{ name: 'bio', type: 'text', nullable: false, key: '' }] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.changed[0].changedFields[0].name).toBe('bio');
  });

  it('counts an untouched table as unchanged, not "changed"', () => {
    const table = { table: 'audit_log', columns: [{ name: 'id', type: 'bigint', nullable: false, key: 'PRI' }] };
    const diff = diffSchemaSnapshots([table], [structuredClone(table)]);
    expect(diff.changed).toHaveLength(0);
    expect(diff.unchangedCount).toBe(1);
  });
});

describe('diffSchemaSnapshots — MongoDB shape (collection/fields)', () => {
  it('detects an added field inferred from a new sample document', () => {
    const before = [{ collection: 'users', count: 5, indexes: ['_id_'], fields: [{ name: 'email', type: 'string' }] }];
    const after = [{ collection: 'users', count: 5, indexes: ['_id_'], fields: [
      { name: 'email', type: 'string' },
      { name: 'age', type: 'number' }
    ] }];
    const diff = diffSchemaSnapshots(before, after);
    expect(diff.changed[0].name).toBe('users');
    expect(diff.changed[0].addedFields[0].name).toBe('age');
  });

  it('detects a new collection', () => {
    const diff = diffSchemaSnapshots([], [{ collection: 'sessions', count: 0, indexes: ['_id_'], fields: [] }]);
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].collection).toBe('sessions');
  });
});

describe('isDiffEmpty', () => {
  it('is true when nothing added, removed, or changed', () => {
    expect(isDiffEmpty({ added: [], removed: [], changed: [] })).toBe(true);
  });

  it('is false when anything changed', () => {
    expect(isDiffEmpty({ added: [{}], removed: [], changed: [] })).toBe(false);
    expect(isDiffEmpty({ added: [], removed: [{}], changed: [] })).toBe(false);
    expect(isDiffEmpty({ added: [], removed: [], changed: [{}] })).toBe(false);
  });
});
