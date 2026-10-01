/**
 * Pre-run validation gate for `up` / `sync` / `up-all`.
 *
 * The same rules `validate` applies are enforced right before migrations run,
 * against exactly the migrations this run will execute (pending, narrowed by
 * --target / --only). Files that were already applied are not re-judged:
 * they ran under whatever rules existed then, and re-validating them would
 * force edits that the checksum gate then rejects.
 *
 * Escape hatches are the same ones `validate` has — CLI --allow-dangerous /
 * --allow-forbidden / --allow <codes>, or the file's own @allow annotations —
 * and every allowance that was used is returned so the caller can log it.
 */

import { selectPendingMigrations } from './base-adapter.js';

// Structural errors that --allow / @allow can release (they're false
// positives of a single-file view, not broken files).
const ALLOWABLE_STRUCTURAL_CODES = new Set(['ORPHAN_DROP_DOWN', 'ORPHAN_DROP_UP', 'FK_UNRESOLVED_REFERENCE']);

/**
 * Split a file's error codes into those an allowance can release and those
 * that need the file fixed (syntax errors, missing Up/Down, DDL in a DCL file…).
 */
function classifyCodes(r) {
  const allowable = new Set();
  for (const op of r.forbiddenOps || []) {
    if (op.type !== 'forbidden-dclReverse') allowable.add(op.code);
  }
  for (const op of r.dangerousOps || []) allowable.add(op.code);
  for (const e of r.errors || []) {
    if (ALLOWABLE_STRUCTURAL_CODES.has(e.code)) allowable.add(e.code);
  }
  const all = [...new Set((r.errors || []).map(e => e.code || e.type).filter(Boolean))];
  return { codes: all, allowable: all.filter(c => allowable.has(c)), mustFix: all.filter(c => !allowable.has(c)) };
}

/** CLI options → the options object adapter.validate() / validateContent() take. */
export function validationOptionsFromCli(options = {}) {
  return {
    allowDangerous: Boolean(options.allowDangerous),
    allowForbidden: Boolean(options.allowForbidden),
    allowedCodes: (options.allow || []).map(c => c.trim().toUpperCase()).filter(Boolean)
  };
}

/**
 * Validate the migrations this run will execute.
 *
 * @param {Object} adapter - connected adapter (validate() reads migrationsDir)
 * @param {string[]} pending - status().pending, in run order
 * @param {Object} options - CLI options (target, only, allowDangerous, allowForbidden, allow)
 * @returns {Promise<{ files: string[], failures: Array<{file: string, codes: string[], allowable: string[], mustFix: string[], messages: string[]}>,
 *   allowed: Array<{file: string, code: string|null, message: string}>, error: string|null }>}
 */
export async function checkMigrationsToRun(adapter, pending, options = {}) {
  const { selected, error } = selectPendingMigrations(pending, options);
  if (error) return { files: [], failures: [], allowed: [], error };
  if (selected.length === 0) return { files: [], failures: [], allowed: [], error: null };

  const result = await adapter.validate({ ...validationOptionsFromCli(options), files: selected });
  if (result.error) {
    return { files: selected, failures: [], allowed: [], error: `validation could not run: ${result.error}` };
  }

  const failures = [];
  const allowed = [];
  for (const r of result.results) {
    if (!r.valid) {
      failures.push({ file: r.file, ...classifyCodes(r), messages: r.errors.map(e => e.message) });
    }
    for (const w of r.warnings || []) {
      // Only allowances that were actually used — the audit trail of what
      // was let through, not every advisory warning.
      if (/-allowed$/.test(w.type || '')) {
        allowed.push({ file: r.file, code: w.code || null, message: w.message });
      }
    }
  }
  return { files: selected, failures, allowed, configWarnings: result.configWarnings || [], error: null };
}

/** One-line-per-file summary for an error message / notification email. */
export function describeValidationFailures(failures) {
  return failures.map(f => `${f.file}: ${f.codes.join(', ')}`);
}

/**
 * The --allow value that would release the overridable failures ('' if none
 * are), and whether some failures can only be fixed in the file itself.
 */
export function allowHintForFailures(failures) {
  return {
    allow: [...new Set(failures.flatMap(f => f.allowable))].join(','),
    needsFix: failures.some(f => f.mustFix.length > 0)
  };
}
