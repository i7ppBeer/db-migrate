/**
 * `dcl --plan`: what a DCL run would do, without doing it.
 *
 * Account statements can't be tried and rolled back (CREATE USER / GRANT
 * commit implicitly on MariaDB; MongoDB user commands aren't transactional),
 * so the plan is built from what's knowable without executing:
 *   - what changed in each pending script since it was last applied (a line
 *     diff against the content stored at apply time — placeholders only,
 *     never passwords)
 *   - every account the script names, whether it exists now and its current
 *     grants/roles
 *   - which accounts would get a generated password (new account / rotation)
 */

import { maskComments } from './source-scan.js';

const PLACEHOLDER = 'CHANGE_ME_ON_FIRST_LOGIN';

/**
 * Line diff (LCS). Returns [{ op: ' ' | '+' | '-', line }].
 * Fine for migration scripts (hundreds of lines at most).
 */
export function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: '-', line: a[i++] }); }
    else { out.push({ op: '+', line: b[j++] }); }
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

/** Only changed lines plus `context` unchanged lines around them ('…' between hunks). */
export function compactDiff(diff, context = 2) {
  const keep = new Set();
  diff.forEach((d, idx) => {
    if (d.op !== ' ') for (let k = idx - context; k <= idx + context; k++) keep.add(k);
  });
  const out = [];
  let last = -1;
  for (let idx = 0; idx < diff.length; idx++) {
    if (!keep.has(idx)) continue;
    if (last !== -1 && idx > last + 1) out.push({ op: '…', line: '' });
    out.push(diff[idx]);
    last = idx;
  }
  return out;
}

/**
 * Accounts a MariaDB DCL script names, per statement kind, with whether the
 * statement sets a placeholder password.
 * @returns {Array<{user: string, host: string, kind: string, placeholder: boolean}>}
 */
export function accountsInSql(sql) {
  const code = maskComments(sql, 'sql');
  const out = [];
  for (const stmt of code.split(';')) {
    const kind = (/^\s*(CREATE\s+USER|ALTER\s+USER|DROP\s+USER|GRANT|REVOKE|SET\s+PASSWORD)\b/i.exec(stmt)?.[1] || '')
      .toUpperCase().replace(/\s+/g, ' ');
    if (!kind) continue;
    const placeholder = stmt.includes(PLACEHOLDER);
    for (const m of stmt.matchAll(/['"`]([^'"`@\s]+)['"`]\s*@\s*['"`]?([^'"`\s,;]+)['"`]?/g)) {
      out.push({ user: m[1], host: m[2], kind, placeholder });
    }
  }
  return out;
}

/**
 * User names a MongoDB DCL script refers to (best effort — the script is
 * code, so names built at runtime can't be seen).
 * @returns {Array<{user: string, placeholder: boolean}>}
 */
export function accountsInJs(js) {
  const code = maskComments(js, 'js');
  const names = new Set();
  const patterns = [
    /\b(?:user|username|createUser|dropUser|updateUser|grantRolesToUser|revokeRolesFromUser)\s*:\s*['"]([^'"]+)['"]/g,
    /\bconst\s+username\s*=\s*['"]([^'"]+)['"]/g
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) names.add(m[1]);
  const placeholder = code.includes(PLACEHOLDER);
  return [...names].map(user => ({ user, placeholder }));
}

/** Current state of one MariaDB account: exists + grants. */
async function mariaAccountState(connection, user, host) {
  const [rows] = await connection.query('SELECT 1 FROM mysql.user WHERE User = ? AND Host = ?', [user, host]);
  if (rows.length === 0) return { exists: false, grants: [] };
  const [grants] = await connection.query(`SHOW GRANTS FOR ${connection.escape(user)}@${connection.escape(host)}`);
  return { exists: true, grants: grants.map(g => Object.values(g)[0]).map(g => g.replace(/ IDENTIFIED BY PASSWORD '[^']*'/, '')) };
}

/** Current state of one MongoDB user (in admin, where DCL scripts create them). */
async function mongoAccountState(client, user) {
  const info = await client.db('admin').command({ usersInfo: user });
  const u = info.users?.[0];
  return u ? { exists: true, grants: (u.roles || []).map(r => `${r.role}@${r.db}`) } : { exists: false, grants: [] };
}

/** What will happen to an account's password, as far as can be told statically. */
function passwordOutcome(account, exists) {
  if (!account.placeholder) return null;
  if (account.kind === 'ALTER USER' || account.kind === 'SET PASSWORD') return 'password will be rotated (new generated password in the notification email)';
  if (account.kind === 'CREATE USER') return exists ? 'already exists — password unchanged' : 'new account — a generated password will be in the notification email';
  if (!account.kind) return exists ? 'exists — the script decides whether its password changes' : 'does not exist yet — a generated password will be in the notification email';
  return null;
}

/**
 * Build the plan for a DCL run.
 * @param {Object} runner - RepeatableRunner
 * @param {Object} adapter - connected adapter
 * @param {Object} context - buildDCLContext() result
 * @returns {Promise<{ files: Array, orphaned: Array, upToDate: number }>}
 */
export async function buildDCLPlan(runner, adapter, context) {
  const status = await runner.status(context);
  const files = [];
  for (const p of status.pending) {
    let diff = null;
    let diffNote = null;
    if (p.reason === 'new file') {
      diffNote = 'new file';
    } else if (p.previousContent == null) {
      diffNote = 'changed — the previously applied version was not recorded (applied before content tracking), so no diff';
    } else {
      diff = compactDiff(diffLines(p.previousContent, p.content));
    }

    const isSql = p.fileName.endsWith('.sql');
    const named = isSql ? accountsInSql(p.content) : accountsInJs(p.content);
    // One entry per account, keeping the statement kind that matters most
    const byKey = new Map();
    for (const a of named) {
      const key = isSql ? `${a.user}@${a.host}` : a.user;
      const prev = byKey.get(key);
      if (!prev || (a.placeholder && !prev.placeholder)) byKey.set(key, { ...a, key });
    }
    const accounts = [];
    for (const a of byKey.values()) {
      let state;
      try {
        state = adapter.dbType === 'mariadb'
          ? await mariaAccountState(adapter.connection, a.user, a.host)
          : await mongoAccountState(adapter.client, a.user);
      } catch (error) {
        state = { exists: null, grants: [], error: error.message };
      }
      accounts.push({ account: a.key, statement: a.kind || null, ...state, password: passwordOutcome(a, state.exists) });
    }
    files.push({ fileName: p.fileName, dir: p.dir, reason: p.reason, diff, diffNote, accounts });
  }
  // multiDir: migrationsDir lists several directories, so say where each file is
  return { files, orphaned: status.orphaned || [], upToDate: status.upToDate.length, multiDir: Array.isArray(context.migrationsDir) };
}
