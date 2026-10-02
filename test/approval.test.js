/**
 * Recording who approved a forbidden operation (@approved-by / --approved-by,
 * validation.requireApprover), and DROP DATABASE reporting one code per form.
 */

import { describe, it, expect } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';
import { MongoDBAdapter } from '../src/adapters/mongodb-adapter.js';
import { checkMigrationsToRun, allowHintForFailures, validationOptionsFromCli } from '../src/core/validation-gate.js';
import { buildNotificationEmail, notificationEmailToHTML } from '../src/core/reporter.js';

const sql = (header, up) => `${header}-- +migrate Up\n${up}\n-- +migrate Down\nSELECT 1;\n`;
const js = (header, up) => `${header}export async function up(db, client) { ${up} }\nexport async function down(db) {}\n`;

describe('approver for forbidden operations', () => {
  it('attaches the file\'s @approved-by to the released forbidden operation', () => {
    const adapter = new MariaDBAdapter({ mariadb: {} });
    const r = adapter.validateContent(sql('-- @allow: DROP_DATABASE\n-- @approved-by: Alice (CAB-123)\n', 'DROP DATABASE old_db;'), 'a.sql');
    expect(r.valid).toBe(true);
    expect(r.approval).toEqual({ approvedBy: 'Alice (CAB-123)', codes: ['DROP_DATABASE'] });
    expect(r.warnings.find(w => w.type === 'forbidden-allowed').approvedBy).toBe('Alice (CAB-123)');
  });

  it('uses --approved-by when the file names nobody', () => {
    const adapter = new MongoDBAdapter({ mongodb: {} });
    const r = adapter.validateContent(js('', 'await db.dropDatabase();'), 'a.js', { allowForbidden: true, approvedBy: 'bob' });
    expect(r.valid).toBe(true);
    expect(r.approval).toEqual({ approvedBy: 'bob', codes: ['DROP_DATABASE'] });
  });

  it('without requireApprover, a release with no approver still passes and says nobody approved', () => {
    const adapter = new MariaDBAdapter({ mariadb: {} });
    const r = adapter.validateContent(sql('-- @allow: DROP_DATABASE\n', 'DROP DATABASE old_db;'), 'a.sql');
    expect(r.valid).toBe(true);
    expect(r.approval).toEqual({ approvedBy: null, codes: ['DROP_DATABASE'] });
  });

  it('with validation.requireApprover, a release with no approver fails with APPROVER_REQUIRED', () => {
    for (const [adapter, content, marker] of [
      [new MariaDBAdapter({ mariadb: {}, validation: { requireApprover: true } }), sql('-- @allow-forbidden: true\n', 'DROP DATABASE old_db;'), '--'],
      [new MongoDBAdapter({ mongodb: {}, validation: { requireApprover: true } }), js('// @allow-forbidden: true\n', 'await db.dropDatabase();'), '//']
    ]) {
      const r = adapter.validateContent(content, 'f');
      expect(r.valid).toBe(false);
      expect(r.forbiddenOps.map(o => o.code)).toEqual(['APPROVER_REQUIRED']);
      expect(r.forbiddenOps[0].message).toContain(`${marker} @approved-by: <name>`);
      expect(adapter.validateContent(content, 'f', { approvedBy: 'carol' }).valid).toBe(true);
    }
  });

  it('requireApprover does not affect dangerous-level allowances', () => {
    const adapter = new MariaDBAdapter({ mariadb: {}, validation: { requireApprover: true } });
    const r = adapter.validateContent(sql('-- @allow-dangerous: true\n', 'TRUNCATE TABLE logs;'), 'a.sql');
    expect(r.approval).toBeNull();
  });

  it('the pre-run gate reports the approver, and does not suggest --allow for a missing one', async () => {
    const files = {
      '001-ok.sql': sql('-- @allow: DROP_DATABASE\n-- @approved-by: alice\n', 'DROP DATABASE a;'),
      '002-noname.sql': sql('-- @allow: DROP_DATABASE\n', 'DROP DATABASE b;')
    };
    const adapter = new MariaDBAdapter({ mariadb: {}, validation: { requireApprover: true } });
    adapter.validate = async (opts) => ({
      valid: false,
      results: opts.files.map(f => ({ file: f, ...adapter.validateContent(files[f], f, opts) }))
    });
    const gate = await checkMigrationsToRun(adapter, Object.keys(files), {});
    expect(gate.allowed).toEqual([expect.objectContaining({ file: '001-ok.sql', code: 'DROP_DATABASE', forbidden: true, approvedBy: 'alice' })]);
    expect(gate.failures.map(f => [f.file, f.mustFix])).toEqual([['002-noname.sql', ['APPROVER_REQUIRED']]]);
    expect(allowHintForFailures(gate.failures).allow).toBe('');
  });

  it('validationOptionsFromCli passes a trimmed --approved-by through', () => {
    expect(validationOptionsFromCli({ approvedBy: '  dave ' }).approvedBy).toBe('dave');
    expect(validationOptionsFromCli({}).approvedBy).toBeUndefined();
  });

  it('the notification email lists approved exceptions', () => {
    const html = notificationEmailToHTML(buildNotificationEmail({
      project: 'shop', dbType: 'mariadb',
      ddl: { applied: ['001-ok.sql'] },
      approvals: [{ file: '001-ok.sql', code: 'DROP_DATABASE', approvedBy: 'alice <ops>' }, { file: '002.sql', code: 'DROP_SCHEMA', approvedBy: null }]
    }));
    expect(html).toContain('Approved exceptions - 2 forbidden operations allowed');
    expect(html).toContain('001-ok.sql [DROP_DATABASE] — approved by alice &lt;ops&gt;');
    expect(html).toContain('002.sql [DROP_SCHEMA] — no approver recorded');
    expect(notificationEmailToHTML(buildNotificationEmail({ project: 'p', dbType: 'mariadb' }))).not.toContain('Approved exceptions');
  });
});

describe('DROP DATABASE reports one code per form', () => {
  it('MariaDB: DROP DATABASE is DROP_DATABASE only, DROP SCHEMA is DROP_SCHEMA only', () => {
    const adapter = new MariaDBAdapter({ mariadb: {} });
    expect(adapter.validateContent(sql('', 'DROP DATABASE x;'), 'a.sql').forbiddenOps.map(o => o.code)).toEqual(['DROP_DATABASE']);
    expect(adapter.validateContent(sql('', 'DROP SCHEMA x;'), 'a.sql').forbiddenOps.map(o => o.code)).toEqual(['DROP_SCHEMA']);
    expect(adapter.validateContent(sql('-- @allow: DROP_DATABASE\n', 'DROP DATABASE x;'), 'a.sql').valid).toBe(true);
    expect(adapter.validateContent(sql('', 'DROP DATABASE x;\nDROP SCHEMA y;'), 'a.sql').forbiddenOps.map(o => o.code).sort())
      .toEqual(['DROP_DATABASE', 'DROP_SCHEMA']);
  });

  it('MongoDB: .dropDatabase() is DROP_DATABASE only, { dropDatabase: 1 } is DROP_DATABASE_CMD only', () => {
    const adapter = new MongoDBAdapter({ mongodb: {} });
    expect(adapter.validateContent(js('', 'await db.dropDatabase();'), 'a.js').forbiddenOps.map(o => o.code)).toEqual(['DROP_DATABASE']);
    expect(adapter.validateContent(js('', 'await db.command({ dropDatabase: 1 });'), 'a.js').forbiddenOps.map(o => o.code)).toEqual(['DROP_DATABASE_CMD']);
    expect(adapter.validateContent(js('// @allow: DROP_DATABASE\n', 'await db.dropDatabase();'), 'a.js').valid).toBe(true);
  });
});
