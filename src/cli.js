#!/usr/bin/env node

/**
 * Unified Database Migration CLI
 * Supports MongoDB and MariaDB/MySQL
 * Supports multiple database instances
 * Supports both Versioned (DDL) and Repeatable (DCL) migrations
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createAdapter, createAdapters, loadConfig } from './adapters/index.js';
import { Reporter } from './core/reporter.js';
import { RepeatableRunner } from './core/repeatable-runner.js';
import { DCLIdempotentChecker } from './core/dcl-idempotent-checker.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('db-migrate')
  .description('Unified database migration tool for MongoDB and MariaDB/MySQL (supports multiple instances, DDL versioned and DCL repeatable modes)')
  .version('2.1.0')
  .option('-c, --config <path>', 'Path to config file')
  .option('-t, --type <type>', 'Database type (mongodb, mariadb)');

/**
 * Load config and create single adapter (for backward compatibility)
 */
async function getAdapter(options) {
  if (!options.config) {
    console.error(chalk.red('[ERROR] Config file is required (-c or --config)'));
    process.exit(1);
  }

  const config = await loadConfig(options.config);
  
  // Resolve migrations directory relative to config file
  if (config.migrationsDir && !path.isAbsolute(config.migrationsDir)) {
    const configDir = path.dirname(path.resolve(options.config));
    config.migrationsDir = path.resolve(configDir, config.migrationsDir);
  }

  // Override type if provided
  if (options.type) {
    config.type = options.type;
  }

  return createAdapter(config);
}

/**
 * Load config and create multiple adapters for multi-instance configs
 */
async function getAdapters(options) {
  if (!options.config) {
    console.error(chalk.red('[ERROR] Config file is required (-c or --config)'));
    process.exit(1);
  }

  const config = await loadConfig(options.config);
  const configDir = path.dirname(path.resolve(options.config));
  
  // Resolve migrations directory relative to config file
  if (config.migrationsDir && !path.isAbsolute(config.migrationsDir)) {
    config.migrationsDir = path.resolve(configDir, config.migrationsDir);
  }
  
  // Handle instances - resolve their migrationsDir too
  if (config.instances) {
    for (const instance of config.instances) {
      if (instance.migrationsDir && !path.isAbsolute(instance.migrationsDir)) {
        instance.migrationsDir = path.resolve(configDir, instance.migrationsDir);
      } else if (!instance.migrationsDir && config.migrationsDir) {
        instance.migrationsDir = config.migrationsDir;
      }
    }
  }

  // Override type if provided
  if (options.type) {
    config.type = options.type;
  }

  return createAdapters(config);
}

// ─────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show migration status')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      const status = await adapter.status();
      
      console.log(chalk.blue(`\n[STATUS] Database: ${adapter.dbType}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      console.log(chalk.green(`\n✅ Applied (${status.applied.length}):`));
      for (const m of status.applied) {
        console.log(`   ${m.fileName} - ${m.appliedAt}`);
      }
      
      console.log(chalk.yellow(`\n⏳ Pending (${status.pending.length}):`));
      for (const f of status.pending) {
        console.log(`   ${f}`);
      }
      
      console.log('');
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('up')
  .description('Run pending migrations')
  .option('--dry-run', 'Show what would be run without executing')
  .option('--sanity-check', 'Enable sanity check (pre-check, post-check, auto-rollback)')
  .option('--no-auto-rollback', 'Disable auto-rollback on sanity check failure')
  .option('--target <migration>', 'Run migrations up to and including this migration')
  .option('--only <migration>', 'Run only this specific migration')
  .option('--instance <name>', 'Run only on specified instance (for multi-instance configs)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      
      // Override sanity check settings from CLI
      if (options.sanityCheck) {
        adapter.config.sanityCheck = {
          ...adapter.config.sanityCheck,
          enabled: true,
          autoRollback: options.autoRollback !== false,
          verbose: true
        };
      }
      
      await adapter.connect();
      
      if (options.dryRun) {
        const status = await adapter.status();
        console.log(chalk.blue('\n[DRY RUN] Would apply these migrations:'));
        for (const f of status.pending) {
          console.log(`   ${f}`);
        }
        return;
      }
      
      console.log(chalk.blue(`\n[UP] Running migrations (${adapter.dbType})...`));
      
      // Prepare migration options
      const migrationOptions = {
        target: options.target,
        only: options.only,
        verbose: true
      };
      
      if (options.target) {
        console.log(chalk.cyan(`   Target: ${options.target}`));
      }
      if (options.only) {
        console.log(chalk.cyan(`   Only: ${options.only}`));
      }
      
      // Use sanity check method if enabled
      let result;
      if (options.sanityCheck && typeof adapter.upWithSanityCheck === 'function') {
        console.log(chalk.cyan('   Sanity Check: ENABLED'));
        console.log(chalk.cyan(`   Auto-Rollback: ${options.autoRollback !== false ? 'ENABLED' : 'DISABLED'}`));
        result = await adapter.upWithSanityCheck(migrationOptions);
      } else {
        result = await adapter.up(migrationOptions);
      }
      
      if (result.applied.length > 0) {
        console.log(chalk.green(`\n✅ Applied ${result.applied.length} migration(s):`));
        for (const m of result.applied) {
          console.log(`   ${m}`);
        }
      } else {
        console.log(chalk.gray('\n   No pending migrations.'));
      }
      
      // Show sanity check results if available
      if (result.sanityResults && result.sanityResults.length > 0) {
        console.log(chalk.cyan('\n📋 Sanity Check Results:'));
        for (const sr of result.sanityResults) {
          if (sr.success) {
            console.log(chalk.green(`   ✅ ${sr.file}: PASSED (${sr.duration}ms)`));
          } else {
            console.log(chalk.red(`   ❌ ${sr.file}: FAILED - ${sr.error}`));
            if (sr.rolledBack) {
              console.log(chalk.yellow(`      ⏪ Auto-rolled back`));
            }
          }
        }
      }
      
      if (result.errors.length > 0) {
        console.error(chalk.red('\n❌ Errors:'));
        for (const e of result.errors) {
          console.error(`   ${e}`);
        }
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('down')
  .description('Rollback migrations')
  .option('-n, --count <number>', 'Number of migrations to rollback', '1')
  .option('--target <migration>', 'Rollback down to and including this migration')
  .option('--instance <name>', 'Run only on specified instance (for multi-instance configs)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      const count = parseInt(options.count, 10);
      console.log(chalk.blue(`\n[DOWN] Rolling back ${count} migration(s) (${adapter.dbType})...`));
      
      const result = await adapter.down(count);
      
      if (result.rolledBack.length > 0) {
        console.log(chalk.yellow(`\n⏪ Rolled back ${result.rolledBack.length} migration(s):`));
        for (const m of result.rolledBack) {
          console.log(`   ${m}`);
        }
      } else {
        console.log(chalk.gray('\n   No migrations to rollback.'));
      }
      
      if (result.errors.length > 0) {
        console.error(chalk.red('\n❌ Errors:'));
        for (const e of result.errors) {
          console.error(`   ${e}`);
        }
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

// ─────────────────────────────────────────────────────────────────
// Baseline Command - For existing databases
// ─────────────────────────────────────────────────────────────────
program
  .command('baseline')
  .description('Mark existing migrations as applied (for existing databases)')
  .option('--all', 'Mark all migration files as applied')
  .option('--up-to <migration>', 'Mark migrations up to and including this one as applied')
  .option('--file <filename>', 'Mark a single specific migration file as applied')
  .option('--dry-run', 'Show what would be marked without actually doing it')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      console.log(chalk.blue(`\n[BASELINE] Marking existing migrations as applied (${adapter.dbType})...`));
      
      // Get all migration files
      const files = await adapter.getMigrationFiles();
      const versionedFiles = files.filter(f => !f.startsWith('R__')); // Exclude repeatable
      
      // Get already applied migrations
      const status = await adapter.status();
      const appliedSet = new Set(status.applied.map(m => m.id || m.name || m));
      
      // Determine which files to mark
      let filesToMark = [];
      
      if (options.all) {
        filesToMark = versionedFiles;
      } else if (options.upTo) {
        const targetFile = versionedFiles.find(f => f.includes(options.upTo));
        if (!targetFile) {
          console.error(chalk.red(`[ERROR] Migration '${options.upTo}' not found`));
          process.exit(1);
        }
        const targetIdx = versionedFiles.indexOf(targetFile);
        filesToMark = versionedFiles.slice(0, targetIdx + 1);
      } else if (options.file) {
        const targetFile = versionedFiles.find(f => f.includes(options.file));
        if (!targetFile) {
          console.error(chalk.red(`[ERROR] Migration '${options.file}' not found`));
          process.exit(1);
        }
        filesToMark = [targetFile];
      } else {
        console.log(chalk.yellow('\n⚠️  Please specify one of: --all, --up-to <migration>, or --file <filename>'));
        console.log(chalk.gray('\nAvailable migrations:'));
        versionedFiles.forEach((f, i) => {
          const applied = appliedSet.has(f.replace('.sql', '').replace('.js', ''));
          const status = applied ? chalk.green('✓') : chalk.gray('○');
          console.log(`   ${status} ${i + 1}. ${f}`);
        });
        return;
      }
      
      // Filter out already applied
      const toApply = filesToMark.filter(f => {
        const id = f.replace('.sql', '').replace('.js', '');
        return !appliedSet.has(id);
      });
      
      if (toApply.length === 0) {
        console.log(chalk.gray('\n   No new migrations to mark as applied.'));
        console.log(chalk.green('   All specified migrations are already recorded.'));
        return;
      }
      
      console.log(chalk.yellow(`\n📋 Will mark ${toApply.length} migration(s) as applied:`));
      toApply.forEach(f => console.log(`   ${f}`));
      
      if (options.dryRun) {
        console.log(chalk.cyan('\n   [DRY RUN] No changes made.'));
        return;
      }
      
      // Mark as applied without executing
      const result = await adapter.baseline(toApply);
      
      if (result.marked && result.marked.length > 0) {
        console.log(chalk.green(`\n✅ Marked ${result.marked.length} migration(s) as applied:`));
        result.marked.forEach(f => console.log(`   ${f}`));
      }
      
      if (result.errors && result.errors.length > 0) {
        console.error(chalk.red('\n❌ Errors:'));
        result.errors.forEach(e => console.error(`   ${e}`));
        process.exitCode = 1;
      }
      
      console.log(chalk.gray('\n💡 Tip: Run "status" to verify the baseline.'));
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('create <name>')
  .description('Create a new DDL (versioned) migration file')
  .action(async (name, cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      
      const fileName = await adapter.create(name);
      console.log(chalk.green(`\n✅ Created: ${fileName}`));
      console.log(chalk.gray('\nRemember to:'));
      console.log('1. Implement the UP section');
      console.log('2. Implement the DOWN section');
      console.log('3. Run validation: db-migrate validate -c <config>');
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('create-dcl <name>')
  .description('Create a new DCL (repeatable) migration file with R__ prefix')
  .option('-n, --number <num>', 'Sequence number (e.g., 001, 002)', '')
  .action(async (name, cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      
      const fileName = await adapter.createDCL(name, options.number);
      console.log(chalk.green(`\n✅ Created: ${fileName}`));
      console.log(chalk.gray('\nRemember:'));
      console.log(chalk.yellow('⚠️  DCL scripts must be IDEMPOTENT (safe to run multiple times)'));
      console.log('1. Use IF NOT EXISTS / IF EXISTS patterns');
      console.log('2. DCL runs whenever checksum changes (no versioning)');
      console.log('3. Run verification: db-migrate dcl:verify -c <config>');
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
  });

program
  .command('validate')
  .description('Validate migration files')
  .option('--allow-dangerous', 'Allow dangerous operations (🟠 level)')
  .option('--allow-forbidden', 'Allow forbidden operations (🔴 level) - requires team approval')
  .option('--allow <codes>', 'Allow specific operation codes (comma-separated)', (val) => val.split(','))
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      
      // Build validation options
      const validateOptions = {
        allowDangerous: options.allowDangerous,
        allowForbidden: options.allowForbidden,
        allowedCodes: options.allow || []
      };
      
      console.log(chalk.blue(`\n[VALIDATE] Checking migrations (${adapter.dbType})...`));
      
      // Show active allowances
      if (options.allowDangerous) {
        console.log(chalk.yellow(`   🟠 --allow-dangerous: Dangerous operations will be allowed`));
      }
      if (options.allowForbidden) {
        console.log(chalk.red(`   🔴 --allow-forbidden: Forbidden operations will be allowed (REQUIRES APPROVAL)`));
      }
      if (options.allow && options.allow.length > 0) {
        console.log(chalk.cyan(`   📋 --allow: ${options.allow.join(', ')}`));
      }
      console.log('');
      
      const result = await adapter.validate(validateOptions);
      
      for (const fileResult of result.results) {
        if (fileResult.valid) {
          console.log(chalk.green(`[OK] ${fileResult.file}`));
        } else {
          console.log(chalk.red(`[ERROR] ${fileResult.file}`));
        }
        
        // Show forbidden operations
        if (fileResult.forbiddenOps && fileResult.forbiddenOps.length > 0) {
          for (const op of fileResult.forbiddenOps) {
            console.log(chalk.red(`   ❌ [${op.code}] ${op.message}`));
          }
        }
        
        // Show dangerous operations
        if (fileResult.dangerousOps && fileResult.dangerousOps.length > 0) {
          for (const op of fileResult.dangerousOps) {
            console.log(chalk.magenta(`   ⛔ [${op.code}] ${op.message}`));
            if (op.suggestion) {
              console.log(chalk.gray(`      └─ 建議: ${op.suggestion}`));
            }
          }
        }
        
        // Show structural errors (orphan drops, etc.)
        const structuralErrors = fileResult.errors.filter(e => 
          !e.type?.startsWith('forbidden') && !e.type?.startsWith('dangerous')
        );
        for (const error of structuralErrors) {
          console.log(chalk.red(`   ❌ ${error.message}`));
        }
        
        // Show warnings
        for (const warning of fileResult.warnings) {
          console.log(chalk.yellow(`   ⚠️  ${warning.message}`));
        }
        
        // Show summary for this file
        if (fileResult.summary) {
          const s = fileResult.summary;
          if (s.forbidden > 0 || s.dangerous > 0) {
            console.log(chalk.gray(`   📊 forbidden:${s.forbidden} dangerous:${s.dangerous} warnings:${s.warnings}`));
          }
        }
      }
      
      console.log(chalk.gray('\n' + '─'.repeat(50)));
      console.log(`Total: ${result.results.length} file(s)`);
      console.log(chalk.green(`Valid: ${result.results.filter(r => r.valid).length}`));
      console.log(chalk.red(`Invalid: ${result.results.filter(r => !r.valid).length}`));
      
      // Show hints if there are errors
      if (!result.valid) {
        const allForbidden = new Set();
        const allDangerous = new Set();
        
        for (const r of result.results) {
          if (r.forbiddenOps) r.forbiddenOps.forEach(op => allForbidden.add(op.code));
          if (r.dangerousOps) r.dangerousOps.forEach(op => allDangerous.add(op.code));
        }
        
        console.log(chalk.cyan('\n💡 放行提示:'));
        
        if (allDangerous.size > 0) {
          console.log(chalk.yellow(`   🟠 危險操作放行: --allow-dangerous`));
          console.log(chalk.gray(`      或指定: --allow ${[...allDangerous].join(',')}`));
        }
        
        if (allForbidden.size > 0) {
          console.log(chalk.red(`   🔴 禁止操作放行: --allow-forbidden (需團隊審批)`));
          console.log(chalk.gray(`      或指定: --allow ${[...allForbidden].join(',')}`));
        }
        
        process.exitCode = 1;
      }
      
      console.log(chalk.green('\n✅ All migrations are valid!'));
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    }
  });

program
  .command('test')
  .description('Run Up-Down-Up test (single instance)')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      console.log(chalk.blue(`\n🧪 Running Up-Down-Up Test (${adapter.dbType})...\n`));
      console.log(chalk.gray('═'.repeat(50)));
      
      const result = await adapter.runUpDownUpTest();
      
      console.log(chalk.gray('\n' + '═'.repeat(50)));
      
      if (result.success) {
        console.log(chalk.green('\n✅ Up-Down-Up Test PASSED!'));
        console.log(chalk.gray(`   Duration: ${(result.duration / 1000).toFixed(2)}s`));
      } else {
        console.log(chalk.red('\n❌ Up-Down-Up Test FAILED!'));
        console.log(chalk.red(`   Error: ${result.error}`));
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('test-instances')
  .description('Run tests on all database instances defined in config')
  .option('-o, --output <dir>', 'Output directory for reports', './reports')
  .option('--validate-only', 'Only run validation, skip Up-Down-Up test')
  .option('--parallel', 'Run tests in parallel (faster but more resource intensive)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    const reporter = new Reporter();
    reporter.start();
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n🔗 Found ${adapters.length} database instance(s):\n`));
    for (const { name, adapter } of adapters) {
      console.log(`   • ${name} (${adapter.dbType})`);
    }
    console.log('');
    
    const runTest = async ({ name, adapter, config }) => {
      const results = [];
      
      try {
        await adapter.connect();
        
        // Run validation
        console.log(chalk.blue(`\n[VALIDATE] ${name} (${adapter.dbType})...`));
        const validateStart = Date.now();
        const validateResult = await adapter.validate();
        
        const validateStatus = {
          database: name,
          dbType: adapter.dbType,
          testType: 'validate',
          success: validateResult.valid,
          duration: Date.now() - validateStart,
          error: validateResult.valid ? null : 'Validation failed',
          details: validateResult.results
        };
        results.push(validateStatus);
        
        if (validateResult.valid) {
          console.log(chalk.green(`   ✅ Validation passed`));
        } else {
          console.log(chalk.red(`   ❌ Validation failed`));
          for (const r of validateResult.results.filter(x => !x.valid)) {
            console.log(chalk.red(`      - ${r.file}: ${r.errors.map(e => e.message).join(', ')}`));
          }
        }
        
        // Run Up-Down-Up test (unless validate-only)
        if (!options.validateOnly) {
          console.log(chalk.blue(`\n[TEST] ${name} (${adapter.dbType}) Up-Down-Up...`));
          const testResult = await adapter.runUpDownUpTest();
          
          const testStatus = {
            database: name,
            dbType: adapter.dbType,
            testType: 'up-down-up',
            success: testResult.success,
            duration: testResult.duration,
            error: testResult.error || null
          };
          results.push(testStatus);
          
          if (testResult.success) {
            console.log(chalk.green(`   ✅ Up-Down-Up test passed (${(testResult.duration / 1000).toFixed(2)}s)`));
          } else {
            console.log(chalk.red(`   ❌ Up-Down-Up test failed: ${testResult.error}`));
          }
        }
        
      } catch (error) {
        results.push({
          database: name,
          dbType: adapter.dbType,
          testType: 'connection',
          success: false,
          duration: 0,
          error: error.message
        });
        console.log(chalk.red(`   ❌ Connection failed: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
      
      return results;
    };
    
    // Run tests (parallel or sequential)
    let allResults = [];
    if (options.parallel) {
      console.log(chalk.yellow('\n⚡ Running tests in parallel...\n'));
      const promises = adapters.map(runTest);
      const resultsArrays = await Promise.all(promises);
      allResults = resultsArrays.flat();
    } else {
      for (const adapterInfo of adapters) {
        const results = await runTest(adapterInfo);
        allResults.push(...results);
      }
    }
    
    // Add all results to reporter
    for (const result of allResults) {
      reporter.addResult(result);
    }
    
    reporter.end();
    reporter.printConsoleReport();
    
    // Save reports
    try {
      const files = await reporter.saveReport(options.output, 'instances');
      console.log(chalk.gray(`\n📁 Reports saved to:`));
      for (const f of files) {
        console.log(`   ${f}`);
      }
    } catch (error) {
      console.log(chalk.yellow(`\n⚠️  Could not save reports: ${error.message}`));
    }
    
    // Exit with error if any tests failed
    const summary = reporter.getSummary();
    if (summary.failed > 0) {
      process.exit(1);
    }
  });

program
  .command('status-all')
  .description('Show migration status for all instances in config')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n📊 Status for ${adapters.length} database instance(s):\n`));
    console.log(chalk.gray('═'.repeat(60)));
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        const status = await adapter.status();
        
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType})`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.green(`  ✅ Applied: ${status.applied.length}`));
        console.log(chalk.yellow(`  ⏳ Pending: ${status.pending.length}`));
        
        if (status.pending.length > 0) {
          console.log(chalk.gray('     Pending migrations:'));
          for (const p of status.pending.slice(0, 5)) {
            console.log(chalk.gray(`       - ${p}`));
          }
          if (status.pending.length > 5) {
            console.log(chalk.gray(`       ... and ${status.pending.length - 5} more`));
          }
        }
        
      } catch (error) {
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType})`));
        console.log(chalk.red(`  ❌ Error: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
    }
    
    console.log(chalk.gray('\n' + '═'.repeat(60)));
  });

program
  .command('up-all')
  .description('Run pending migrations on all instances')
  .option('--dry-run', 'Show what would be run without executing')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n🚀 Running migrations on ${adapters.length} instance(s)...\n`));
    
    let hasErrors = false;
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        
        if (options.dryRun) {
          const status = await adapter.status();
          console.log(chalk.blue(`\n[${name}] Would apply ${status.pending.length} migration(s)`));
          for (const p of status.pending) {
            console.log(chalk.gray(`   - ${p}`));
          }
        } else {
          console.log(chalk.blue(`\n[${name}] Running migrations...`));
          const result = await adapter.up();
          
          if (result.applied.length > 0) {
            console.log(chalk.green(`   ✅ Applied ${result.applied.length} migration(s)`));
          } else {
            console.log(chalk.gray(`   No pending migrations`));
          }
          
          if (result.errors.length > 0) {
            hasErrors = true;
            console.log(chalk.red(`   ❌ Errors:`));
            for (const e of result.errors) {
              console.log(chalk.red(`      - ${e}`));
            }
          }
        }
        
      } catch (error) {
        hasErrors = true;
        console.log(chalk.red(`\n[${name}] ❌ Error: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
    }
    
    if (hasErrors) {
      process.exit(1);
    }
  });

program
  .command('test-all')
  .description('Run all tests and generate report')
  .option('-o, --output <dir>', 'Output directory for reports', './reports')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    const reporter = new Reporter();
    reporter.start();
    
    // Find all database configs
    const dbDirs = ['databases/mongodb', 'databases/mariadb'];
    
    for (const dbDir of dbDirs) {
      try {
        const fullPath = path.resolve(process.cwd(), dbDir);
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
          
          const configPath = path.join(fullPath, entry.name, 'config.js');
          
          try {
            await fs.access(configPath);
          } catch {
            continue; // No config file
          }
          
          const dbType = dbDir.includes('mongodb') ? 'mongodb' : 'mariadb';
          let adapter;
          
          try {
            const config = await loadConfig(configPath);
            if (config.migrationsDir && !path.isAbsolute(config.migrationsDir)) {
              config.migrationsDir = path.resolve(path.dirname(configPath), config.migrationsDir);
            }
            config.type = dbType;
            
            adapter = createAdapter(config);
            await adapter.connect();
            
            // Run validation
            console.log(chalk.blue(`\n[VALIDATE] ${entry.name} (${dbType})...`));
            const validateStart = Date.now();
            const validateResult = await adapter.validate();
            reporter.addResult({
              database: entry.name,
              dbType,
              testType: 'validate',
              success: validateResult.valid,
              duration: Date.now() - validateStart,
              error: validateResult.valid ? null : 'Validation failed'
            });
            
            // Run Up-Down-Up test
            console.log(chalk.blue(`\n[TEST] ${entry.name} (${dbType}) Up-Down-Up...`));
            const testResult = await adapter.runUpDownUpTest();
            reporter.addResult({
              database: entry.name,
              dbType,
              testType: 'up-down-up',
              success: testResult.success,
              duration: testResult.duration,
              error: testResult.error || null
            });
            
          } catch (error) {
            reporter.addResult({
              database: entry.name,
              dbType,
              testType: 'connection',
              success: false,
              duration: 0,
              error: error.message
            });
          } finally {
            if (adapter) await adapter.disconnect();
          }
        }
      } catch (error) {
        // Directory doesn't exist, skip
      }
    }
    
    reporter.end();
    reporter.printConsoleReport();
    
    // Save reports
    const files = await reporter.saveReport(options.output, 'all');
    console.log(chalk.gray(`\n📁 Reports saved to:`));
    for (const f of files) {
      console.log(`   ${f}`);
    }
    
    // Exit with error if any tests failed
    const summary = reporter.getSummary();
    if (summary.failed > 0) {
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────
// DCL Repeatable Migration Commands
// ─────────────────────────────────────────────────────────────────

program
  .command('dcl')
  .description('Run DCL repeatable migrations (checksum-based)')
  .option('--dry-run', 'Show what would be run without executing')
  .option('--validate', 'Enable validation before running (blocks dangerous operations)')
  .option('--allow-dangerous', 'Allow dangerous operations when validating')
  .option('--allow-forbidden', 'Allow forbidden operations when validating (requires approval)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      const config = await loadConfig(options.config);
      const configDir = path.dirname(path.resolve(options.config));
      const migrationsDir = config.migrationsDir && !path.isAbsolute(config.migrationsDir)
        ? path.resolve(configDir, config.migrationsDir)
        : config.migrationsDir;
      
      const runner = new RepeatableRunner({
        checksumTable: config.checksumTable || config.checksumCollection || 'repeatable_migrations'
      });
      
      const context = {
        dbType: adapter.dbType,
        connection: adapter.connection,
        db: adapter.db,
        client: adapter.client,
        migrationsDir,
        // Pass validator if validation is enabled
        validator: options.validate ? adapter : null
      };
      
      if (options.dryRun) {
        const status = await runner.status(context);
        console.log(chalk.blue('\n[DRY RUN] Would apply these DCL migrations:'));
        for (const p of status.pending) {
          console.log(`   ${p.fileName} (${p.reason})`);
        }
        console.log(chalk.gray(`\n   Up-to-date: ${status.upToDate.length}`));
        return;
      }
      
      console.log(chalk.blue(`\n[DCL] Running repeatable migrations (${adapter.dbType})...`));
      if (options.validate) {
        console.log(chalk.cyan('   Validation: ENABLED'));
        if (options.allowDangerous) {
          console.log(chalk.yellow('   --allow-dangerous: Dangerous operations allowed'));
        }
        if (options.allowForbidden) {
          console.log(chalk.red('   --allow-forbidden: Forbidden operations allowed (REQUIRES APPROVAL)'));
        }
      }
      
      const result = await runner.run(context);
      
      if (result.applied.length > 0) {
        console.log(chalk.green(`\n✅ Applied ${result.applied.length} DCL migration(s):`));
        for (const m of result.applied) {
          const annotationInfo = m.annotations?.allowDangerous ? chalk.yellow(' [allow-dangerous]') : '';
          console.log(`   ${m.fileName} (${m.reason})${annotationInfo}`);
        }
      } else if (!result.skipped || result.skipped.length === 0) {
        console.log(chalk.gray('\n   All DCL migrations are up-to-date.'));
      }
      
      // Show skipped migrations
      if (result.skipped && result.skipped.length > 0) {
        console.log(chalk.yellow(`\n⏭️  Skipped ${result.skipped.length} migration(s) due to validation:`));
        for (const s of result.skipped) {
          console.log(chalk.yellow(`   ${s.fileName}: ${s.reason}`));
          if (s.hint) {
            console.log(chalk.gray(`      💡 ${s.hint}`));
          }
        }
      }
      
      if (result.errors.length > 0) {
        console.error(chalk.red('\n❌ Errors:'));
        for (const e of result.errors) {
          console.error(`   ${e}`);
        }
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('dcl:status')
  .description('Show DCL repeatable migration status')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      const config = await loadConfig(options.config);
      const configDir = path.dirname(path.resolve(options.config));
      const migrationsDir = config.migrationsDir && !path.isAbsolute(config.migrationsDir)
        ? path.resolve(configDir, config.migrationsDir)
        : config.migrationsDir;
      
      const runner = new RepeatableRunner({
        checksumTable: config.checksumTable || config.checksumCollection || 'repeatable_migrations'
      });
      
      const context = {
        dbType: adapter.dbType,
        connection: adapter.connection,
        db: adapter.db,
        client: adapter.client,
        migrationsDir
      };
      
      const status = await runner.status(context);
      
      console.log(chalk.blue(`\n[DCL STATUS] Database: ${adapter.dbType}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      console.log(chalk.yellow(`\n⏳ Pending (${status.pending.length}):`));
      for (const p of status.pending) {
        console.log(`   ${p.fileName}`);
        console.log(chalk.gray(`      Reason: ${p.reason}`));
      }
      
      console.log(chalk.green(`\n✅ Up-to-date (${status.upToDate.length}):`));
      for (const u of status.upToDate) {
        console.log(`   ${u.fileName}`);
        console.log(chalk.gray(`      Applied: ${u.appliedAt}`));
      }
      
      console.log('');
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('dcl:verify')
  .description('Verify DCL scripts are idempotent')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      await adapter.connect();
      
      const config = await loadConfig(options.config);
      const configDir = path.dirname(path.resolve(options.config));
      const migrationsDir = config.migrationsDir && !path.isAbsolute(config.migrationsDir)
        ? path.resolve(configDir, config.migrationsDir)
        : config.migrationsDir;
      
      const runner = new RepeatableRunner({
        checksumTable: config.checksumTable || config.checksumCollection || 'repeatable_migrations'
      });
      
      const checker = new DCLIdempotentChecker({
        verbose: config.idempotencyCheck?.verbose ?? true
      });
      
      const context = {
        dbType: adapter.dbType,
        connection: adapter.connection,
        db: adapter.db,
        client: adapter.client,
        migrationsDir
      };
      
      console.log(chalk.blue(`\n[DCL VERIFY] Testing idempotency (${adapter.dbType})...\n`));
      console.log(chalk.gray('═'.repeat(50)));
      
      const files = await runner.getRepeatableFiles(migrationsDir);
      let allPassed = true;
      
      for (const file of files) {
        console.log(chalk.blue(`\n📄 ${file.fileName}`));
        
        const executeScript = async () => {
          if (adapter.dbType === 'mariadb') {
            // Use query instead of execute for multiple statements
            await adapter.connection.query(file.content);
          } else if (adapter.dbType === 'mongodb') {
            const module = await import(`file://${file.filePath}`);
            if (typeof module.up === 'function') {
              await module.up(adapter.db, adapter.client);
            }
          }
        };
        
        const result = await checker.verify(context, executeScript, {
          database: config.database,
          scriptName: file.fileName
        });
        
        if (result.success) {
          console.log(chalk.green(`   ✅ IDEMPOTENT`));
        } else {
          console.log(chalk.red(`   ❌ NOT IDEMPOTENT: ${result.error}`));
          allPassed = false;
        }
      }
      
      console.log(chalk.gray('\n' + '═'.repeat(50)));
      
      if (allPassed) {
        console.log(chalk.green('\n✅ All DCL scripts are idempotent!'));
      } else {
        console.log(chalk.red('\n❌ Some DCL scripts failed idempotency check!'));
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program.parse();
