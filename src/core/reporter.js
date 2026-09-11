/**
 * Migration Reporter
 * Generates test reports in various formats
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * Escape HTML special characters to prevent XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a structured report for a single `sync` run (status -> up -> schema
 * snapshot). Separate from Reporter above because that class' shape is a list
 * of pass/fail test results (built for test-all across many configs); a sync
 * run is one attempt against one database with a nested schema snapshot,
 * which doesn't fit that row shape.
 *
 * @param {Object} data
 * @param {string} data.dbType - 'mariadb' | 'mongodb'
 * @param {string} [data.database] - database/schema name, if known
 * @param {'applied'|'no-pending'|'failed'} data.status
 * @param {string[]} data.pending - migrations that were pending before running
 * @param {string[]} data.applied - migrations actually applied this run
 * @param {string[]} [data.errors] - error messages, if status === 'failed'
 * @param {number} data.durationMs
 * @param {Array} [data.schema] - adapter.getSchemaSnapshot() result, omitted on failure/no-pending
 * @returns {Object} plain JSON-serializable report object
 */
export function buildSyncReport(data) {
  return {
    generatedAt: new Date().toISOString(),
    dbType: data.dbType,
    database: data.database ?? null,
    status: data.status,
    durationMs: data.durationMs,
    pending: data.pending ?? [],
    applied: data.applied ?? [],
    errors: data.errors ?? [],
    schema: data.schema ?? null
  };
}

/**
 * Render a sync report as a single self-contained HTML page.
 * @param {Object} report - from buildSyncReport()
 * @returns {string}
 */
export function syncReportToHTML(report) {
  const statusLabel = { applied: '✅ APPLIED', 'no-pending': '⚠️ NO PENDING', failed: '❌ FAILED' }[report.status] || report.status;
  const statusClass = { applied: 'pass', 'no-pending': 'warn', failed: 'fail' }[report.status] || '';

  const schemaHTML = !report.schema ? '' : report.schema.map(item => {
    if ('table' in item) {
      const rowsLabel = item.rows === null ? 'unknown rows' : `~${item.rows.toLocaleString()} rows`;
      const cols = item.columns.map(c => `
          <tr>
            <td><code>${escapeHtml(c.name)}</code></td>
            <td>${escapeHtml(c.type)}</td>
            <td>${c.nullable ? 'YES' : 'NO'}</td>
            <td>${escapeHtml(c.key || '')}</td>
          </tr>`).join('');
      return `
      <div class="schema-item">
        <h3>📦 ${escapeHtml(item.table)} <span class="badge">${escapeHtml(item.engine || '')}, ${escapeHtml(rowsLabel)}</span></h3>
        <table><thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Key</th></tr></thead>
        <tbody>${cols}</tbody></table>
      </div>`;
    }
    const fields = item.fields.map(f => `
          <tr><td><code>${escapeHtml(f.name)}</code></td><td>${escapeHtml(f.type)}</td></tr>`).join('');
    return `
      <div class="schema-item">
        <h3>📦 ${escapeHtml(item.collection)} <span class="badge">~${item.count.toLocaleString()} docs, indexes: ${escapeHtml(item.indexes.join(', '))}</span></h3>
        <table><thead><tr><th>Field</th><th>Inferred type</th></tr></thead>
        <tbody>${fields}</tbody></table>
      </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sync Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; color: #1f2937; }
    .container { max-width: 1000px; margin: 0 auto; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .status { display: inline-block; padding: 4px 14px; border-radius: 20px; font-size: 13px; font-weight: 600; margin-top: 8px; }
    .status.pass { background: #dcfce7; color: #166534; }
    .status.warn { background: #fef9c3; color: #854d0e; }
    .status.fail { background: #fee2e2; color: #991b1b; }
    .card { background: white; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .card h2 { font-size: 16px; margin-bottom: 10px; }
    ul { margin-left: 20px; font-size: 14px; }
    li { margin-bottom: 4px; }
    .error { color: #ef4444; }
    .schema-item { margin-bottom: 18px; }
    .schema-item h3 { font-size: 14px; margin-bottom: 6px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; background: #e5e7eb; color: #374151; font-weight: 400; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f9fafb; font-weight: 600; color: #374151; }
    code { font-family: 'SF Mono', Consolas, monospace; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🔄 Sync Report</h1>
      <div class="meta">${escapeHtml(report.dbType)}${report.database ? ' / ' + escapeHtml(report.database) : ''} — generated ${escapeHtml(report.generatedAt)} — ${(report.durationMs / 1000).toFixed(2)}s</div>
      <div class="status ${statusClass}">${statusLabel}</div>
    </div>

    ${report.errors.length > 0 ? `
    <div class="card">
      <h2>Errors</h2>
      <ul>${report.errors.map(e => `<li class="error">${escapeHtml(e)}</li>`).join('')}</ul>
    </div>` : ''}

    <div class="card">
      <h2>Applied (${report.applied.length})</h2>
      <ul>${report.applied.map(m => `<li>✅ ${escapeHtml(m)}</li>`).join('') || '<li>(none)</li>'}</ul>
    </div>

    ${report.status === 'no-pending' ? `
    <div class="card"><h2>Pending</h2><ul><li>(none — already up to date)</li></ul></div>` : ''}

    ${report.schema ? `
    <div class="card">
      <h2>Current Schema (${report.schema.length})</h2>
      ${schemaHTML}
    </div>` : ''}
  </div>
</body>
</html>`;
}

/**
 * Save a sync report to <outputDir>/sync-report-<timestamp>.{json,html}.
 * @param {string} outputDir
 * @param {Object} report - from buildSyncReport()
 * @param {string} [format] - 'json', 'html', or 'all' (default)
 * @returns {Promise<string[]>} paths written
 */
export async function saveSyncReport(outputDir, report, format = 'all') {
  await fs.mkdir(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files = [];

  if (format === 'json' || format === 'all') {
    const jsonPath = path.join(outputDir, `sync-report-${timestamp}.json`);
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
    files.push(jsonPath);
  }
  if (format === 'html' || format === 'all') {
    const htmlPath = path.join(outputDir, `sync-report-${timestamp}.html`);
    await fs.writeFile(htmlPath, syncReportToHTML(report));
    files.push(htmlPath);
  }
  return files;
}

export class Reporter {
  constructor() {
    this.results = [];
    this.startTime = null;
    this.endTime = null;
  }

  start() {
    this.startTime = new Date();
    this.results = [];
  }

  addResult(result) {
    this.results.push({
      ...result,
      timestamp: new Date().toISOString()
    });
  }

  end() {
    this.endTime = new Date();
  }

  /**
   * Generate summary statistics
   */
  getSummary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.success).length;
    const failed = total - passed;
    const duration = this.endTime - this.startTime;

    return {
      total,
      passed,
      failed,
      passRate: total > 0 ? ((passed / total) * 100).toFixed(1) : '0.0',
      duration,
      startTime: this.startTime?.toISOString(),
      endTime: this.endTime?.toISOString()
    };
  }

  /**
   * Generate console report
   */
  printConsoleReport() {
    const summary = this.getSummary();
    
    console.log('\n');
    console.log('═'.repeat(70));
    console.log('                    📊 MIGRATION TEST REPORT');
    console.log('═'.repeat(70));
    console.log(`  Start Time:  ${summary.startTime}`);
    console.log(`  End Time:    ${summary.endTime}`);
    console.log(`  Duration:    ${(summary.duration / 1000).toFixed(2)}s`);
    console.log('─'.repeat(70));
    
    // Results table
    console.log('\n  RESULTS BY DATABASE:\n');
    console.log('  ' + '─'.repeat(66));
    console.log(`  ${'Database'.padEnd(20)} ${'Type'.padEnd(10)} ${'Test'.padEnd(15)} ${'Status'.padEnd(10)} Duration`);
    console.log('  ' + '─'.repeat(66));
    
    for (const result of this.results) {
      const status = result.success ? '✅ PASS' : '❌ FAIL';
      const duration = `${(result.duration / 1000).toFixed(2)}s`;
      console.log(`  ${result.database.padEnd(20)} ${result.dbType.padEnd(10)} ${result.testType.padEnd(15)} ${status.padEnd(10)} ${duration}`);
      
      if (!result.success && result.error) {
        console.log(`     └─ Error: ${result.error}`);
      }
    }
    
    console.log('  ' + '─'.repeat(66));
    
    // Summary
    console.log('\n  SUMMARY:');
    console.log('  ' + '─'.repeat(66));
    console.log(`  Total Tests:    ${summary.total}`);
    console.log(`  Passed:         ${summary.passed} ✅`);
    console.log(`  Failed:         ${summary.failed} ${summary.failed > 0 ? '❌' : ''}`);
    console.log(`  Pass Rate:      ${summary.passRate}%`);

    // Breakdown by testType
    const byType = {};
    for (const r of this.results) {
      if (!byType[r.testType]) byType[r.testType] = { passed: 0, failed: 0 };
      byType[r.testType][r.success ? 'passed' : 'failed']++;
    }
    const typeOrder = ['validate', 'up-down-up', 'sanity-check', 'dcl-idempotency'];
    const allTypes = [...new Set([...typeOrder, ...Object.keys(byType)])];
    console.log('\n  BY TEST TYPE:');
    for (const t of allTypes) {
      if (!byType[t]) continue;
      const { passed: p, failed: f } = byType[t];
      const icon = f > 0 ? '❌' : '✅';
      console.log(`  ${icon}  ${t.padEnd(18)} passed: ${p}  failed: ${f}`);
    }
    console.log('  ' + '─'.repeat(66));
    
    // Final status
    console.log('\n');
    if (summary.failed === 0) {
      console.log('  ╔════════════════════════════════════════════════════════════════╗');
      console.log('  ║               ✅ ALL TESTS PASSED SUCCESSFULLY                 ║');
      console.log('  ╚════════════════════════════════════════════════════════════════╝');
    } else {
      console.log('  ╔════════════════════════════════════════════════════════════════╗');
      console.log(`  ║               ❌ ${summary.failed} TEST(S) FAILED                              ║`);
      console.log('  ╚════════════════════════════════════════════════════════════════╝');
    }
    console.log('\n');
  }

  /**
   * Generate JSON report
   */
  toJSON() {
    return {
      summary: this.getSummary(),
      results: this.results,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generate HTML report
   */
  toHTML() {
    const summary = this.getSummary();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Migration Test Report</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 10px; margin-bottom: 20px; }
    .header h1 { font-size: 24px; margin-bottom: 10px; }
    .header .meta { opacity: 0.9; font-size: 14px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .summary-card { background: white; padding: 20px; border-radius: 10px; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .summary-card .value { font-size: 32px; font-weight: bold; color: #333; }
    .summary-card .label { font-size: 14px; color: #666; margin-top: 5px; }
    .summary-card.passed .value { color: #22c55e; }
    .summary-card.failed .value { color: #ef4444; }
    .results { background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .results h2 { padding: 20px; border-bottom: 1px solid #eee; font-size: 18px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 15px 20px; text-align: left; border-bottom: 1px solid #eee; }
    th { background: #f9fafb; font-weight: 600; color: #374151; }
    .status { padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .status.pass { background: #dcfce7; color: #166534; }
    .status.fail { background: #fee2e2; color: #991b1b; }
    .error { color: #ef4444; font-size: 13px; margin-top: 5px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; background: #e5e7eb; color: #374151; }
    .badge.mongodb { background: #dcfce7; color: #166534; }
    .badge.mariadb { background: #dbeafe; color: #1e40af; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Migration Test Report</h1>
      <div class="meta">
        Generated: ${summary.endTime} | Duration: ${(summary.duration / 1000).toFixed(2)}s
      </div>
    </div>
    
    <div class="summary">
      <div class="summary-card">
        <div class="value">${summary.total}</div>
        <div class="label">Total Tests</div>
      </div>
      <div class="summary-card passed">
        <div class="value">${summary.passed}</div>
        <div class="label">Passed</div>
      </div>
      <div class="summary-card failed">
        <div class="value">${summary.failed}</div>
        <div class="label">Failed</div>
      </div>
      <div class="summary-card">
        <div class="value">${summary.passRate}%</div>
        <div class="label">Pass Rate</div>
      </div>
    </div>
    
    <div class="results">
      <h2>Test Results</h2>
      <table>
        <thead>
          <tr>
            <th>Database</th>
            <th>Type</th>
            <th>Test</th>
            <th>Status</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${this.results.map(r => `
          <tr>
            <td><strong>${escapeHtml(r.database)}</strong></td>
            <td><span class="badge ${escapeHtml(r.dbType)}">${escapeHtml(r.dbType)}</span></td>
            <td>${escapeHtml(r.testType)}</td>
            <td><span class="status ${r.success ? 'pass' : 'fail'}">${r.success ? '✅ PASS' : '❌ FAIL'}</span>${r.error ? `<div class="error">${escapeHtml(r.error)}</div>` : ''}</td>
            <td>${(r.duration / 1000).toFixed(2)}s</td>
          </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * Save report to file
   * @param {string} outputPath 
   * @param {string} format - 'json', 'html', or 'all'
   */
  async saveReport(outputDir, format = 'all') {
    await fs.mkdir(outputDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const files = [];

    if (format === 'json' || format === 'all') {
      const jsonPath = path.join(outputDir, `report-${timestamp}.json`);
      await fs.writeFile(jsonPath, JSON.stringify(this.toJSON(), null, 2));
      files.push(jsonPath);
    }

    if (format === 'html' || format === 'all') {
      const htmlPath = path.join(outputDir, `report-${timestamp}.html`);
      await fs.writeFile(htmlPath, this.toHTML());
      files.push(htmlPath);
    }

    return files;
  }
}

export default Reporter;
