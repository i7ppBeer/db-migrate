/**
 * Migration Reporter
 * Generates test reports in various formats
 */

import fs from 'fs/promises';
import path from 'path';

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
      passRate: total > 0 ? ((passed / total) * 100).toFixed(1) : 0,
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
            <td><strong>${r.database}</strong></td>
            <td><span class="badge ${r.dbType}">${r.dbType}</span></td>
            <td>${r.testType}</td>
            <td><span class="status ${r.success ? 'pass' : 'fail'}">${r.success ? '✅ PASS' : '❌ FAIL'}</span>${r.error ? `<div class="error">${r.error}</div>` : ''}</td>
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
