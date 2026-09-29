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
 * @param {Object} [data.schemaDiff] - diffSchemaSnapshots() result (before vs. after), omitted on failure/no-pending
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
    schema: data.schema ?? null,
    schemaDiff: data.schemaDiff ?? null
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

  const diff = report.schemaDiff;
  const diffIsEmpty = diff && diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
  const diffHTML = !diff ? '' : (diffIsEmpty ? '<p class="diff-empty">(schema unchanged)</p>' : `
    <ul class="diff-list">
      ${diff.added.map(item => `<li class="diff-added">+ 📦 ${escapeHtml(item.table ?? item.collection)} <span class="badge">new</span></li>`).join('')}
      ${diff.removed.map(item => `<li class="diff-removed">- 📦 ${escapeHtml(item.table ?? item.collection)} <span class="badge">removed</span></li>`).join('')}
      ${diff.changed.map(c => `
      <li class="diff-changed">~ 📦 ${escapeHtml(c.name)}
        <ul class="diff-fields">
          ${c.addedFields.map(f => `<li class="diff-added">+ ${escapeHtml(f.name)} <code>${escapeHtml(f.type ?? '')}</code></li>`).join('')}
          ${c.removedFields.map(f => `<li class="diff-removed">- ${escapeHtml(f.name)}</li>`).join('')}
          ${c.changedFields.map(f => `<li class="diff-changed">~ ${escapeHtml(f.name)}: <code>${escapeHtml(f.before.type ?? '')}</code> → <code>${escapeHtml(f.after.type ?? '')}</code></li>`).join('')}
        </ul>
      </li>`).join('')}
    </ul>
    ${diff.unchangedCount > 0 ? `<p class="diff-empty">Unchanged: ${diff.unchangedCount}</p>` : ''}
  `);

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
    .diff-list { list-style: none; font-size: 13px; }
    .diff-list > li { margin-bottom: 6px; }
    .diff-fields { list-style: none; margin: 4px 0 4px 20px; }
    .diff-added { color: #166534; }
    .diff-removed { color: #991b1b; }
    .diff-changed { color: #854d0e; }
    .diff-empty { color: #6b7280; font-size: 13px; }
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

    ${diff ? `
    <div class="card">
      <h2>Schema Changes</h2>
      ${diffHTML}
    </div>` : ''}

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

// ─── Run notification email ──────────────────────────────────────────────
// Renders the run's account/schema changes as a single self-contained,
// table-based, inline-styled HTML email — the only place a DCL-generated
// password appears (RepeatableRunner never writes one to disk; see
// recordCredentialEvents() in repeatable-runner.js and docs/DCL-PASSWORD.md).
// Deliberately styled for maximum mail-client compatibility: no webfonts, no
// external CSS/JS, bgcolor attributes alongside inline background-color for
// Outlook's Word rendering engine, and color-scheme pinned to light so a
// client's dark mode doesn't invert the event colors.

const DCL_EVENT_STYLE = {
  new:                 { label: 'NEW',                  bg: '#e4f2e8', chipBg: '#c9e6d3', border: '#2f7a4f', text: '#20553a', chipText: '#20553a' },
  password_changed:    { label: 'PASSWORD CHANGED',      bg: '#dff1f3', chipBg: '#bfe3e8', border: '#1f7a8c', text: '#134c56', chipText: '#125764' },
  no_change:           { label: 'NO CHANGE',             bg: '#eceef1', chipBg: '#dfe2e6', border: '#6b7280', text: '#494e55', chipText: '#41464e' },
  removed:             { label: 'REMOVED',                bg: '#fbe8ea', chipBg: '#f3ccd1', border: '#b0303f', text: '#6e232d', chipText: '#7a1f2b' },
  permissions_updated: { label: 'PERMISSIONS UPDATED',    bg: '#ecebfa', chipBg: '#d6d5f5', border: '#5b5fc7', text: '#33368f', chipText: '#33368f' }
};

function dclEventRowHTML(event) {
  const style = DCL_EVENT_STYLE[event.type];
  if (!style) return '';
  const chip = `<span style="font-family:Arial,sans-serif;font-size:10px;font-weight:bold;color:${style.chipText};background:${style.chipBg};padding:2px 7px;">${escapeHtml(style.label)}</span>`;
  const user = `<span style="font-family:'Courier New',monospace;font-size:14px;color:#1c211d;font-weight:bold;">${escapeHtml(event.username)}</span>`;

  let detail;
  if (event.type === 'new' || event.type === 'password_changed') {
    const label = event.type === 'new' ? 'Password' : 'New password';
    detail = event.password
      ? `<span style="font-family:Arial,sans-serif;font-size:12px;color:${style.text};">${label}: </span>` +
        `<span style="font-family:'Courier New',monospace;font-size:13px;color:#1c211d;font-weight:bold;background:#ffffff;padding:1px 6px;border:1px solid ${style.border};">${escapeHtml(event.password)}</span><br>` +
        `<span style="font-family:Arial,sans-serif;font-size:11px;color:#5b6259;">Temporary password - expires on first login, must be changed immediately.</span>`
      : `<span style="font-family:Arial,sans-serif;font-size:12px;color:${style.text};">New account - credentials were not auto-generated for this one.</span>`;
  } else if (event.type === 'no_change') {
    detail = `<span style="font-family:Arial,sans-serif;font-size:12px;color:${style.text};">Account already existed - password unchanged.</span>`;
  } else if (event.type === 'removed') {
    detail = `<span style="font-family:Arial,sans-serif;font-size:12px;color:${style.text};">Account and all grants revoked.</span>`;
  } else {
    const added = (event.grantsAdded || []).map(g => `+ ${g}`);
    const removed = (event.grantsRemoved || []).map(g => `- ${g}`);
    const lines = [...removed, ...added].map(g => escapeHtml(g)).join('<br>');
    detail = `<span style="font-family:'Courier New',monospace;font-size:12px;color:${style.text};">${lines}</span>`;
  }

  return `<tr><td style="padding:0 28px 8px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="${style.bg}" style="background:${style.bg};border-left:3px solid ${style.border};padding:12px 14px;">` +
    `${chip}<br>${user}<br>${detail}</td></tr></table></td></tr>`;
}

/**
 * Build a structured notification-email report for one migration run.
 * @param {Object} data
 * @param {string} data.project - project/config name shown in the header
 * @param {string} [data.environment] - e.g. 'production', 'staging'
 * @param {string} data.dbType - 'mariadb' | 'mongodb'
 * @param {'success'|'failed'|'skipped'} [data.status] - default 'success'. 'failed'
 *   shows a red banner and renders ddl.errors/dcl.errors as a failure block above
 *   the normal sections, so a partial run's applied/events lists still show what
 *   DID complete before the failure. 'skipped' is for a deliberate no-op (e.g.
 *   sync's "0 pending migrations" exit) — distinct from success so it's visibly
 *   not "nothing happened, silently".
 * @param {Object} [data.ddl] - { applied: string[], diff?: schemaDiff, errors?: string[] }
 * @param {Object} [data.dcl] - { events?: Array<{type, username, password?, grantsAdded?, grantsRemoved?}>, errors?: string[], skipped?: Array<{fileName, reason}> }
 * @returns {Object} plain JSON-serializable report object
 */
export function buildNotificationEmail(data) {
  return {
    generatedAt: new Date().toISOString(),
    project: data.project,
    environment: data.environment ?? null,
    dbType: data.dbType,
    status: data.status ?? 'success',
    ddl: data.ddl ?? null,
    dcl: data.dcl ?? null
  };
}

/**
 * Render a notification-email report as a single, standalone, mail-client-safe
 * HTML document (own <!doctype>/<html> — this is not an Artifact-style page
 * fragment, it is the literal email body).
 * @param {Object} report - from buildNotificationEmail()
 * @returns {string}
 */
const STATUS_BANNER = {
  success: { label: 'Success', bg: '#e4f2e8', border: '#2f7a4f', text: '#20553a' },
  failed:  { label: 'Failed',  bg: '#fbe8ea', border: '#b0303f', text: '#6e232d' },
  skipped: { label: 'Skipped — nothing to do', bg: '#fdf3e3', border: '#a8752a', text: '#6e4d1c' }
};

function failureBlockHTML(heading, errors) {
  if (!errors || errors.length === 0) return '';
  const lines = errors.map(e => escapeHtml(e)).join('<br>');
  return `<tr><td style="padding:18px 28px 6px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;text-transform:uppercase;">${escapeHtml(heading)}</td></tr>` +
    `<tr><td style="padding:0 28px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="#fbe8ea" style="background:#fbe8ea;border-left:3px solid #b0303f;padding:10px 14px;font-family:'Courier New',monospace;font-size:12px;color:#6e232d;">${lines}</td>` +
    `</tr></table></td></tr>`;
}

export function notificationEmailToHTML(report) {
  const metaParts = [report.environment, report.dbType].filter(Boolean);
  const meta = escapeHtml([...metaParts, new Date(report.generatedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'].join(' | '));

  const status = STATUS_BANNER[report.status] || STATUS_BANNER.success;
  const statusHTML = `<tr><td style="padding:4px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td bgcolor="${status.bg}" style="background:${status.bg};border-left:3px solid ${status.border};padding:8px 14px;font-family:Arial,sans-serif;font-size:12px;font-weight:bold;color:${status.text};">${escapeHtml(status.label)}</td>` +
    `</tr></table></td></tr>`;

  const ddlFailureHTML = failureBlockHTML(
    report.ddl && report.ddl.applied && report.ddl.applied.length > 0 ? 'Schema changes — failed after partial apply' : 'Schema changes — failed',
    report.ddl && report.ddl.errors
  );
  const dclFailureHTML = failureBlockHTML('Account changes — failed', report.dcl && report.dcl.errors);
  const dclSkippedHTML = (report.dcl && report.dcl.skipped && report.dcl.skipped.length > 0)
    ? failureBlockHTML('Account changes — skipped by validation', report.dcl.skipped.map(s => `${s.fileName}: ${s.reason}`))
    : '';

  let ddlHTML = '';
  if (report.ddl && report.ddl.applied && report.ddl.applied.length > 0) {
    const list = report.ddl.applied.map(m => escapeHtml(m)).join('<br>');
    const diff = report.ddl.diff;
    let diffRows = '';
    if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) {
      const lines = [];
      for (const item of diff.added) lines.push(`+ ${item.table ?? item.collection} added`);
      for (const item of diff.removed) lines.push(`- ${item.table ?? item.collection} removed`);
      for (const c of diff.changed) {
        for (const f of c.addedFields) lines.push(`+ ${c.name}.${f.name} ${f.type ?? ''}`.trim());
        for (const f of c.removedFields) lines.push(`- ${c.name}.${f.name}`);
        for (const f of c.changedFields) lines.push(`~ ${c.name}.${f.name}: ${f.before.type ?? ''} -> ${f.after.type ?? ''}`);
      }
      diffRows = `<tr><td style="padding:0 28px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
        lines.map((l, i) => `<tr><td bgcolor="#e4f2e8" style="background:#e4f2e8;border-left:3px solid #2f7a4f;padding:8px 12px;font-family:'Courier New',monospace;font-size:12px;color:#20553a;">${escapeHtml(l)}</td></tr>` +
          (i < lines.length - 1 ? `<tr><td style="height:6px;font-size:1px;line-height:6px;">&nbsp;</td></tr>` : '')).join('') +
        `</table></td></tr>`;
    }
    const appliedLabel = report.status === 'failed'
      ? `Schema changes - ${report.ddl.applied.length} migration${report.ddl.applied.length === 1 ? '' : 's'} applied before the failure`
      : `Schema changes - ${report.ddl.applied.length} migration${report.ddl.applied.length === 1 ? '' : 's'} applied`;
    ddlHTML = `<tr><td style="padding:18px 28px 6px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;text-transform:uppercase;">${escapeHtml(appliedLabel)}</td></tr>` +
      `<tr><td style="padding:2px 28px 12px;font-family:'Courier New',monospace;font-size:13px;color:#1c211d;">${list}</td></tr>` +
      diffRows;
  }

  let dclHTML = '';
  if (report.dcl && report.dcl.events && report.dcl.events.length > 0) {
    dclHTML = `<tr><td style="padding:18px 28px 10px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;text-transform:uppercase;">Account changes - ${report.dcl.events.length} event${report.dcl.events.length === 1 ? '' : 's'}</td></tr>` +
      report.dcl.events.map(dclEventRowHTML).join('');
  }

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>Migration Notification</title></head>` +
    `<body style="margin:0;padding:0;background:#eef1ee;font-family:Arial,Helvetica,sans-serif;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef1ee" style="background:#eef1ee;"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid #d7ddd4;">` +
    `<tr><td bgcolor="#171b21" style="background:#171b21;padding:18px 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td style="font-family:Arial,sans-serif;color:#ffffff;font-size:15px;font-weight:bold;">Migration Notification</td>` +
    `<td align="right" style="font-family:Arial,sans-serif;color:#c9cdc6;font-size:12px;">${escapeHtml(report.project)}</td>` +
    `</tr></table></td></tr>` +
    `<tr><td style="padding:20px 28px 4px;font-family:Arial,sans-serif;font-size:12px;color:#5b6259;">${meta}</td></tr>` +
    statusHTML +
    ddlFailureHTML + dclFailureHTML + dclSkippedHTML +
    ddlHTML + dclHTML +
    `<tr><td style="padding:18px 28px 22px;border-top:1px solid #d7ddd4;font-family:Arial,sans-serif;font-size:11px;color:#8a8f86;">This is an automated migration notification. Do not reply.</td></tr>` +
    `</table></td></tr></table></body></html>`;
}

/**
 * Save a notification email to <outputDir>/<fileName>. Unlike saveSyncReport,
 * the file name is fixed (not timestamped) by default — this file is meant to
 * be fetched by a fixed, known path (e.g. `kubectl exec ... cat`) right after
 * the run, not archived alongside other reports.
 * @param {string} outputDir
 * @param {string} html - from notificationEmailToHTML()
 * @param {string} [fileName]
 * @returns {Promise<string>} path written
 */
export async function saveNotificationEmail(outputDir, html, fileName = 'notification.html') {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, fileName);
  await fs.writeFile(filePath, html, 'utf-8');
  return filePath;
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
