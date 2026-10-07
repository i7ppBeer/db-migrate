/**
 * Base Adapter Interface
 * All database adapters must implement this interface
 */

import path from 'path';
import { describeDirs } from './migration-dirs.js';

/**
 * `R__*` files are repeatable (DCL) migrations. A versioned (DDL) project
 * ignores them everywhere — status, up, down, validate — so both adapters
 * agree on what a DDL migration is. They belong in a DCL project.
 */
export function isRepeatableMigrationFile(fileName) {
  return /^R__/.test(path.basename(fileName));
}

/**
 * The subset of pending migrations an `up` run will execute, given
 * --target (up to and including) / --only (just that one). Shared by both
 * adapters' up() and the CLI's pre-run validation gate, so the gate checks
 * exactly what will run. Matches an exact file name first, then a substring.
 *
 * @param {string[]} pending - pending file names, in run order
 * @param {{target?: string, only?: string}} [options]
 * @returns {{ selected: string[], error: string|null }}
 */
export function selectPendingMigrations(pending, { target, only } = {}) {
  const find = (list, needle) => {
    const exact = list.findIndex(f => f === needle || f.replace(/\.(sql|js)$/, '') === needle);
    return exact !== -1 ? exact : list.findIndex(f => f.includes(needle));
  };
  let selected = pending;
  if (target) {
    const i = find(selected, target);
    if (i === -1) return { selected: [], error: `Target migration not found: ${target}` };
    selected = selected.slice(0, i + 1);
  }
  if (only) {
    const i = find(selected, only);
    if (i === -1) return { selected: [], error: `Migration not found in pending: ${only}` };
    selected = [selected[i]];
  }
  return { selected, error: null };
}

/**
 * Thresholds for the pre-execution runtime gates (R2–R4, see
 * docs/RUNTIME-GATE-PLAN.md), overridable per config under `runtimeGates`.
 */
export const RUNTIME_GATE_DEFAULTS = {
  // R2: a transaction / operation open longer than this blocks the run
  longTransactionSec: 60,
  // R3: replication lag above this is reported (never blocks)
  replicationLagWarnSec: 30,
  // R4: binary logs larger than this in total are reported (MariaDB, never blocks)
  binlogWarnMb: 10240,
  // R4: filesystem usage above this is reported (MongoDB, never blocks)
  diskUsageWarnPercent: 90,
  // R4: a pending MongoDB migration running an index build or a bulk
  // update/delete on a collection with at least this many documents is
  // reported (never blocks); 0 turns the check off
  largeCollectionDocs: 1000000,
  // R4: a pending MariaDB migration running an ALTER TABLE, index build or
  // bulk UPDATE/DELETE on a table with at least this many rows (InnoDB's
  // estimate) is reported (never blocks); 0 turns the check off
  largeTableRows: 1000000,
  // R2: refuse when the open-transaction / lock check itself couldn't run
  // (missing PROCESS / clusterMonitor privilege) instead of skipping it —
  // for production, where "skipped" must not quietly mean "unchecked"
  requireLockCheck: false
};

/** Never relaxable via validation.rules: the file couldn't run at all. */
export const PROTECTED_RULE_CODES = ['MISSING_UP_MARKER', 'MISSING_UP_EXPORT', 'JS_SYNTAX_ERROR'];

export class BaseAdapter {
  constructor(config) {
    // A list of directories is a DCL-only feature (core/migration-dirs.js):
    // a DDL changelog has to come from one place.
    if (config && Array.isArray(config.migrationsDir) && config.mode !== 'repeatable') {
      throw new Error(`migrationsDir lists ${config.migrationsDir.length} directories, but only DCL configs (mode: 'repeatable') accept a list — a DDL config takes one directory.`);
    }
    this.config = config;
    this.dbType = 'unknown';
  }

  /**
   * Config-level validation settings (both optional):
   *   validation.allow:          { '<file name>': ['CODE', …] } — per-file
   *                              allowances kept in config instead of in the
   *                              file (e.g. for files already applied)
   *   validation.existingTables (MariaDB) / validation.existingCollections
   *   (MongoDB): ['name', …] — tables/collections that exist without a
   *                              migration creating them (pre-existing or
   *                              baselined), for the FK and drop checks
   *   validation.requireApprover: true — a forbidden operation that was
   *                              allowed must name who approved it
   *                              (@approved-by / --approved-by), see applyApproval()
   * @returns {{allow: Object<string,string[]>, existing: string[], requireApprover: boolean}}
   */
  getValidationConfig() {
    const v = this.config.validation || {};
    const allow = {};
    for (const [file, codes] of Object.entries(v.allow || {})) {
      allow[file] = (Array.isArray(codes) ? codes : String(codes).split(',')).map(c => String(c).trim().toUpperCase()).filter(Boolean);
    }
    const existing = v.existingTables || v.existingCollections || [];
    // MariaDB table names compare case-insensitively here; MongoDB's don't
    return {
      allow,
      existing: existing.map(t => (this.dbType === 'mongodb' ? String(t) : String(t).toLowerCase())),
      requireApprover: v.requireApprover === true
    };
  }

  /**
   * Who approved a released forbidden operation. Runs after applyRulePolicy()
   * in validateContent(): every 'forbidden-allowed' warning gets the approver
   * (file's @approved-by, else --approved-by) attached so it shows up in the
   * run log and the notification email. With validation.requireApprover on
   * and nobody named, those releases are turned back into failures.
   *
   * @returns the policy result plus `approval`: null when nothing forbidden
   *   was released, else { approvedBy: string|null, codes: string[] }
   */
  applyApproval(policy, approvedBy) {
    const released = policy.warnings.filter(w => w.type === 'forbidden-allowed');
    if (released.length === 0) return { ...policy, approval: null };
    const approver = typeof approvedBy === 'string' ? approvedBy.trim() : '';
    const codes = [...new Set(released.map(w => w.code).filter(Boolean))];
    if (approver) {
      return {
        ...policy,
        warnings: policy.warnings.map(w => (released.includes(w) ? { ...w, approvedBy: approver } : w)),
        approval: { approvedBy: approver, codes }
      };
    }
    if (!this.getValidationConfig().requireApprover) return { ...policy, approval: { approvedBy: null, codes } };
    const marker = this.dbType === 'mongodb' ? '//' : '--';
    return {
      ...policy,
      warnings: policy.warnings.filter(w => !released.includes(w)),
      forbiddenOps: [...policy.forbiddenOps, ...released.map(w => ({
        type: 'approver-required',
        code: 'APPROVER_REQUIRED',
        releasedCode: w.code,
        message: `🔴 ${w.code || 'A forbidden operation'} is allowed, but no approver is recorded and validation.requireApprover is on — ` +
          `add "${marker} @approved-by: <name>" to the file or pass --approved-by <name>`
      }))],
      approval: null
    };
  }

  /**
   * Project policy for validation rules, from config:
   *
   *   validation.rules:       { CODE: 'off' | 'warn' | 'error' }
   *     off   — the rule doesn't apply in this project
   *     warn  — reported, never blocks
   *     error — a warning-level rule (e.g. a custom one) blocks like a
   *             dangerous op (still releasable with @allow / --allow)
   *   validation.customRules: [{ code, pattern, level, message, suggestion?, flags? }]
   *     level: 'forbidden' | 'dangerous' | 'warning'; pattern is a regex
   *     string matched (case-insensitive by default) against each Up
   *     statement (MariaDB) / up() body (MongoDB), comments and string
   *     literals removed
   *
   * Codes in PROTECTED_RULE_CODES can't be relaxed: the file couldn't run at
   * all, or DDL would end up inside a DCL project.
   * @returns {{ rules: Object<string,string>, customRules: Array, problems: string[] }}
   */
  getValidationPolicy() {
    if (this._validationPolicy) return this._validationPolicy;
    const v = this.config.validation || {};
    const problems = [];
    const known = this.knownValidationCodes();
    const protectedCodes = new Set([...PROTECTED_RULE_CODES, ...this.protectedValidationCodes()]);

    const customRules = [];
    for (const [i, r] of (v.customRules || []).entries()) {
      const where = `validation.customRules[${i}]`;
      const code = String(r?.code || '').trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(code)) { problems.push(`${where}: needs a code like MY_RULE`); continue; }
      if (!['forbidden', 'dangerous', 'warning'].includes(r.level)) { problems.push(`${where} (${code}): level must be 'forbidden', 'dangerous' or 'warning'`); continue; }
      if (!r.message) { problems.push(`${where} (${code}): needs a message`); continue; }
      let pattern;
      try {
        pattern = r.pattern instanceof RegExp ? r.pattern : new RegExp(String(r.pattern), r.flags ?? 'i');
      } catch (error) {
        problems.push(`${where} (${code}): invalid pattern — ${error.message}`);
        continue;
      }
      customRules.push({ code, level: r.level, pattern, message: r.message, suggestion: r.suggestion });
      known.add(code);
    }

    const rules = {};
    for (const [rawCode, setting] of Object.entries(v.rules || {})) {
      const code = rawCode.toUpperCase();
      if (!['off', 'warn', 'error'].includes(setting)) { problems.push(`validation.rules.${rawCode}: must be 'off', 'warn' or 'error'`); continue; }
      if (protectedCodes.has(code)) { problems.push(`validation.rules.${rawCode}: can't be changed — the file couldn't run or would mix DDL into DCL`); continue; }
      if (!known.has(code)) { problems.push(`validation.rules.${rawCode}: no such rule code for ${this.dbType} — misspelled?`); continue; }
      rules[code] = setting;
    }

    this._validationPolicy = { rules, customRules, problems };
    return this._validationPolicy;
  }

  /** Every rule code this adapter can report (overridden per adapter). */
  knownValidationCodes() {
    return new Set();
  }

  /** Codes on top of PROTECTED_RULE_CODES that this adapter won't let config relax. */
  protectedValidationCodes() {
    return [];
  }

  /**
   * Apply validation.rules to one file's findings (in place) and return them.
   * off: dropped everywhere; warn: errors become warnings; error: coded
   * warnings become dangerous ops.
   */
  applyRulePolicy({ errors, forbiddenOps, dangerousOps, warnings }) {
    const { rules } = this.getValidationPolicy();
    if (Object.keys(rules).length === 0) return { errors, forbiddenOps, dangerousOps, warnings };
    const setting = (item) => (item && item.code ? rules[item.code] : undefined);
    const downgraded = [];
    const relax = (list) => list.filter(item => {
      const s = setting(item);
      if (s === 'off') return false;
      if (s === 'warn') {
        downgraded.push({ type: 'downgraded', code: item.code, message: `⚠️ [warn via validation.rules] ${item.message}`, suggestion: item.suggestion });
        return false;
      }
      return true;
    });
    const out = {
      errors: relax(errors),
      forbiddenOps: relax(forbiddenOps),
      dangerousOps: relax(dangerousOps),
      warnings: []
    };
    for (const w of warnings) {
      const s = setting(w);
      if (s === 'off') continue;
      if (s === 'error') {
        out.dangerousOps.push({ type: 'dangerous-upgraded', code: w.code, message: `🟠 [error via validation.rules] ${w.message.replace(/^⚠️\s*/, '')}`, suggestion: w.suggestion });
        continue;
      }
      out.warnings.push(w);
    }
    out.warnings.push(...downgraded);
    return out;
  }

  /**
   * Evaluate validation.customRules against the given texts (statements or
   * function bodies, already normalized). Allowances work as for built-ins.
   */
  evaluateCustomRules(texts, options, { forbiddenOps, dangerousOps, warnings }) {
    for (const rule of this.getValidationPolicy().customRules) {
      if (!texts.some(t => { rule.pattern.lastIndex = 0; return rule.pattern.test(t); })) continue;
      const message = `${rule.level === 'forbidden' ? '🔴' : rule.level === 'dangerous' ? '🟠' : '⚠️'} ${rule.message}`;
      if (rule.level === 'warning') {
        warnings.push({ type: 'warning', code: rule.code, message, suggestion: rule.suggestion });
        continue;
      }
      const allowed = (rule.level === 'forbidden' ? options.allowForbidden : options.allowDangerous) ||
        (options.allowedCodes || []).includes(rule.code);
      if (allowed) {
        warnings.push({ type: rule.level === 'forbidden' ? 'forbidden-allowed' : 'dangerous-allowed', code: rule.code, message: `✅ [ALLOWED] ${message}`, suggestion: rule.suggestion });
      } else {
        (rule.level === 'forbidden' ? forbiddenOps : dangerousOps).push({ type: `${rule.level}-custom`, code: rule.code, message, suggestion: rule.suggestion });
      }
    }
  }

  /** Warnings about validation config that points at nothing (renamed/typo'd files). */
  checkValidationConfig(migrationFiles) {
    const files = new Set(migrationFiles);
    return [
      ...Object.keys(this.getValidationConfig().allow)
        .filter(f => !files.has(f))
        .map(f => `validation.allow lists '${f}', which is not a migration file in ${describeDirs(this.config.migrationsDir)} — renamed or misspelled?`),
      ...this.getValidationPolicy().problems
    ];
  }

  /** runtimeGates thresholds from config, over RUNTIME_GATE_DEFAULTS. */
  getRuntimeGateConfig() {
    return { ...RUNTIME_GATE_DEFAULTS, ...(this.config.runtimeGates || {}) };
  }

  /**
   * Get database type identifier
   * @returns {string}
   */
  getType() {
    return this.dbType;
  }

  /**
   * Connect to database
   * @returns {Promise<void>}
   */
  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  /**
   * Disconnect from database
   * @returns {Promise<void>}
   */
  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  /**
   * Get migration status
   * @returns {Promise<{pending: Array, applied: Array}>}
   */
  async status() {
    throw new Error('status() must be implemented by subclass');
  }

  /**
   * Run pending migrations (up)
   * @returns {Promise<{applied: Array, errors: Array}>}
   */
  async up() {
    throw new Error('up() must be implemented by subclass');
  }

  /**
   * Rollback last migration (down)
   * @param {number} count - Number of migrations to rollback
   * @returns {Promise<{rolledBack: Array, errors: Array}>}
   */
  async down(_count = 1) {
    throw new Error('down() must be implemented by subclass');
  }

  /**
   * Create a new migration file
   * @param {string} name - Migration name
   * @returns {Promise<string>} - Created file path
   */
  async create(_name) {
    throw new Error('create() must be implemented by subclass');
  }

  /**
   * Validate migration files
   * @returns {Promise<{valid: boolean, results: Array}>}
   */
  async validate() {
    throw new Error('validate() must be implemented by subclass');
  }

  /**
   * Get validation rules for this database type
   * @returns {Object}
   */
  getValidationRules() {
    throw new Error('getValidationRules() must be implemented by subclass');
  }

  /**
   * Run Up-Down-Up test
   * @returns {Promise<{success: boolean, stages: Object}>}
   */
  async runUpDownUpTest() {
    const results = {
      success: false,
      stages: {
        up1: { success: false, count: 0, error: null },
        down: { success: false, count: 0, error: null },
        up2: { success: false, count: 0, error: null }
      },
      duration: 0
    };

    const startTime = Date.now();

    try {
      // Stage 1: UP
      console.log('\n📤 Stage 1: Running UP migrations...');
      const up1Result = await this.up();
      results.stages.up1 = {
        success: up1Result.errors.length === 0,
        count: up1Result.applied.length,
        applied: up1Result.applied,
        error: up1Result.errors[0] || null
      };

      if (!results.stages.up1.success) {
        throw new Error(`Stage 1 (UP) failed: ${results.stages.up1.error}`);
      }
      console.log(`   ✅ Applied ${results.stages.up1.count} migrations`);

      // Get the total number of applied migrations after Stage 1
      // (may be more than up1.count if some were already applied from a previous run)
      const statusAfterUp1 = await this.status();
      const totalApplied = statusAfterUp1.applied.length;

      // Stage 2: DOWN (rollback all currently applied migrations)
      console.log('\n📥 Stage 2: Running DOWN migrations (rollback)...');
      const downResult = await this.down(totalApplied);
      results.stages.down = {
        success: downResult.errors.length === 0,
        count: downResult.rolledBack.length,
        rolledBack: downResult.rolledBack,
        error: downResult.errors[0] || null
      };

      if (!results.stages.down.success) {
        throw new Error(`Stage 2 (DOWN) failed: ${results.stages.down.error}`);
      }
      console.log(`   ✅ Rolled back ${results.stages.down.count} migrations`);

      // Stage 3: UP again
      console.log('\n📤 Stage 3: Running UP migrations again...');
      const up2Result = await this.up();
      results.stages.up2 = {
        success: up2Result.errors.length === 0,
        count: up2Result.applied.length,
        applied: up2Result.applied,
        error: up2Result.errors[0] || null
      };

      if (!results.stages.up2.success) {
        throw new Error(`Stage 3 (UP Again) failed: ${results.stages.up2.error}`);
      }
      console.log(`   ✅ Re-applied ${results.stages.up2.count} migrations`);

      // Verify Stage 3 re-applied as many as Stage 2 rolled back
      if (results.stages.down.count !== results.stages.up2.count) {
        throw new Error(
          `Migration count mismatch: Stage 2 rolled back ${results.stages.down.count}, ` +
          `Stage 3 re-applied ${results.stages.up2.count}`
        );
      }

      results.success = true;

    } catch (error) {
      results.error = error.message;
      // Attempt cleanup on failure to restore to a known state
      try {
        console.warn('\n⚠️  Test failed, attempting cleanup...');
        const cleanupStatus = await this.status();
        await this.down(cleanupStatus.applied.length || 0);
        console.warn('   Cleanup completed.');
      } catch (cleanupError) {
        console.error(`   ❌ Cleanup also failed: ${cleanupError.message}`);
      }
    }

    results.duration = Date.now() - startTime;
    return results;
  }
}

export default BaseAdapter;
