/**
 * CLI Tests with Sanity Check Options
 * 測試 CLI 的 Sanity Check 選項
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

describe('CLI Sanity Check Options', () => {
  let program;

  beforeEach(() => {
    // Create fresh Command instance for each test
    program = new Command();
    
    // Add the up command with sanity check options (mimicking cli.js)
    program
      .command('up')
      .description('Run pending migrations')
      .option('--sanity-check', 'Enable sanity check (pre/post checks with auto-rollback)', false)
      .option('--no-auto-rollback', 'Disable auto-rollback on sanity check failure')
      .action((options) => {
        // Store options for testing
        program.upOptions = options;
      });
  });

  describe('--sanity-check flag', () => {
    it('should default to disabled', () => {
      program.parse(['node', 'test', 'up'], { from: 'user' });
      expect(program.upOptions.sanityCheck).toBe(false);
    });

    it('should enable sanity check when flag is provided', () => {
      program.parse(['node', 'test', 'up', '--sanity-check'], { from: 'user' });
      expect(program.upOptions.sanityCheck).toBe(true);
    });
  });

  describe('--no-auto-rollback flag', () => {
    it('should default autoRollback to true', () => {
      program.parse(['node', 'test', 'up'], { from: 'user' });
      expect(program.upOptions.autoRollback).toBe(true);
    });

    it('should disable autoRollback when --no-auto-rollback is provided', () => {
      program.parse(['node', 'test', 'up', '--no-auto-rollback'], { from: 'user' });
      expect(program.upOptions.autoRollback).toBe(false);
    });

    it('should work with --sanity-check flag', () => {
      program.parse(['node', 'test', 'up', '--sanity-check', '--no-auto-rollback'], { from: 'user' });
      expect(program.upOptions.sanityCheck).toBe(true);
      expect(program.upOptions.autoRollback).toBe(false);
    });
  });

  describe('Combined options', () => {
    it('should accept all options together', () => {
      program.parse(['node', 'test', 'up', '--sanity-check', '--no-auto-rollback'], { from: 'user' });
      
      expect(program.upOptions.sanityCheck).toBe(true);
      expect(program.upOptions.autoRollback).toBe(false);
    });
  });
});

describe('Sanity Check Result Display', () => {
  // Helper to format sanity check result for display
  function formatSanityResult(result) {
    const lines = [];
    
    if (result.preCheckResult) {
      lines.push(`Pre-Check: ${result.preCheckResult.success ? '✅ PASS' : '❌ FAIL'}`);
      if (result.preCheckResult.details) {
        result.preCheckResult.details.forEach(d => lines.push(`  - ${d}`));
      }
      if (result.preCheckResult.error) {
        lines.push(`  Error: ${result.preCheckResult.error}`);
      }
    }

    if (result.migrationExecuted) {
      lines.push(`Migration: ✅ Executed`);
    } else if (result.preCheckResult && !result.preCheckResult.success) {
      lines.push(`Migration: ⏭️ Skipped (pre-check failed)`);
    }

    if (result.postCheckResult) {
      lines.push(`Post-Check: ${result.postCheckResult.success ? '✅ PASS' : '❌ FAIL'}`);
      if (result.postCheckResult.details) {
        result.postCheckResult.details.forEach(d => lines.push(`  - ${d}`));
      }
      if (result.postCheckResult.error) {
        lines.push(`  Error: ${result.postCheckResult.error}`);
      }
    }

    if (result.rolledBack) {
      lines.push(`Rollback: ✅ Auto-rollback executed`);
    }

    if (result.rollbackError) {
      lines.push(`Rollback: ❌ Failed - ${result.rollbackError.message}`);
    }

    return lines.join('\n');
  }

  it('should format successful result', () => {
    const result = {
      success: true,
      preCheckResult: { success: true, details: ['Collection exists'] },
      migrationExecuted: true,
      postCheckResult: { success: true, details: ['Index created'] },
      rolledBack: false
    };

    const output = formatSanityResult(result);
    
    expect(output).toContain('Pre-Check: ✅ PASS');
    expect(output).toContain('Collection exists');
    expect(output).toContain('Migration: ✅ Executed');
    expect(output).toContain('Post-Check: ✅ PASS');
    expect(output).toContain('Index created');
  });

  it('should format pre-check failure', () => {
    const result = {
      success: false,
      preCheckResult: { success: false, error: 'Collection already exists' },
      migrationExecuted: false,
      postCheckResult: null,
      rolledBack: false
    };

    const output = formatSanityResult(result);
    
    expect(output).toContain('Pre-Check: ❌ FAIL');
    expect(output).toContain('Collection already exists');
    expect(output).toContain('Migration: ⏭️ Skipped');
  });

  it('should format post-check failure with rollback', () => {
    const result = {
      success: false,
      preCheckResult: { success: true },
      migrationExecuted: true,
      postCheckResult: { success: false, error: 'Index creation failed' },
      rolledBack: true
    };

    const output = formatSanityResult(result);
    
    expect(output).toContain('Pre-Check: ✅ PASS');
    expect(output).toContain('Migration: ✅ Executed');
    expect(output).toContain('Post-Check: ❌ FAIL');
    expect(output).toContain('Auto-rollback executed');
  });

  it('should format rollback failure', () => {
    const result = {
      success: false,
      preCheckResult: { success: true },
      migrationExecuted: true,
      postCheckResult: { success: false, error: 'Check failed' },
      rolledBack: false,
      rollbackError: new Error('Connection lost during rollback')
    };

    const output = formatSanityResult(result);
    
    expect(output).toContain('Rollback: ❌ Failed');
    expect(output).toContain('Connection lost during rollback');
  });
});
