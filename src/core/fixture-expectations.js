/**
 * Per-file expected validation outcomes for test fixtures.
 *
 * A fixture migration that is *meant* to be rejected says exactly how, in
 * its own first lines:
 *
 *   -- @expect-error: TRUNCATE_TABLE          (SQL)
 *   // @expect-error: DROP_DATABASE           (JS)
 *
 * test-all then checks that this file fails validation with exactly those
 * codes — not merely that "something in the directory failed", which let a
 * fixture pass for the wrong reason (or stop being rejected at all) unnoticed.
 * A file without the annotation must validate cleanly.
 */

/** Expected error codes declared in a migration file, or null if none. */
export function parseExpectedErrors(content) {
  const m = /^\s*(?:--|\/\/)\s*@expect-error\s*:\s*(.+)$/m.exec(content || '');
  if (!m) return null;
  return [...new Set(m[1].split(',').map(c => c.trim().toUpperCase()).filter(Boolean))].sort();
}

/**
 * Compare one file's validate() result with its expectation.
 * @param {Object} fileResult - an entry of adapter.validate().results
 * @param {string[]|null} expected - from parseExpectedErrors()
 * @returns {{ ok: boolean, message: string|null }}
 */
export function checkFileExpectation(fileResult, expected) {
  const actual = [...new Set((fileResult.errors || []).map(e => e.code || e.type).filter(Boolean))].sort();
  if (!expected) {
    return fileResult.valid
      ? { ok: true, message: null }
      : { ok: false, message: `expected to be valid, but failed with ${actual.join(', ')}` };
  }
  if (fileResult.valid) {
    return { ok: false, message: `expected to fail with ${expected.join(', ')}, but it passed validation` };
  }
  const missing = expected.filter(c => !actual.includes(c));
  const unexpected = actual.filter(c => !expected.includes(c));
  if (missing.length === 0 && unexpected.length === 0) return { ok: true, message: null };
  return {
    ok: false,
    message: [
      missing.length ? `missing expected ${missing.join(', ')}` : null,
      unexpected.length ? `unexpected ${unexpected.join(', ')}` : null
    ].filter(Boolean).join('; ')
  };
}
