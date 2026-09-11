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
import { Reporter, buildSyncReport, saveSyncReport } from './core/reporter.js';
import { diffSchemaSnapshots, isDiffEmpty } from './core/schema-diff.js';
import { RepeatableRunner, mongodbHelpers } from './core/repeatable-runner.js';
import { DCLIdempotentChecker } from './core/dcl-idempotent-checker.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const program = new Command();

program
  .name('db-migrate')
  .description('Unified database migration tool for MongoDB and MariaDB/MySQL (supports multiple instances, DDL versioned and DCL repeatable modes)')
  .version('2.1.0')
  .option('-c, --config <path>', 'Path to config file')
  .option('-t, --type <type>', 'Database type (mongodb, mariadb)');

/**
 * Resolve a config's migrationsDir to an absolute path, relative to the
 * directory the config file itself lives in. Returns the value unchanged if
 * it's already absolute or not set.
 */
function resolveMigrationsDir(config, configPath) {
  if (!config.migrationsDir || path.isAbsolute(config.migrationsDir)) {
    return config.migrationsDir;
  }
  const configDir = path.dirname(path.resolve(configPath));
  return path.resolve(configDir, config.migrationsDir);
}

/**
 * Resolve the checksum table/collection name for a DCL (repeatable) config,
 * with the same fallback chain RepeatableRunner's constructor expects.
 */
function resolveChecksumTable(config) {
  return config.checksumTable || config.checksumCollection || 'repeatable_migrations';
}

/**
 * Load config and create single adapter (for backward compatibility)
 */
async function getAdapter(options) {
  if (!options.config) {
    console.error(chalk.red('[ERROR] Config file is required (-c or --config)'));
    process.exit(1);
  }

  const config = await loadConfig(options.config);
  config.migrationsDir = resolveMigrationsDir(config, options.config);

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
  config.migrationsDir = resolveMigrationsDir(config, options.config);

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

/**
 * Pretty-print a schema snapshot (from adapter.getSchemaSnapshot()) to the console.
 * Same shape for both db types at the top level (an array of "containers"), but
 * MariaDB containers are tables with columns, MongoDB containers are collections
 * with indexes + an inferred field shape from one sample document.
 */
function printSchemaSnapshot(snapshot, dbType) {
  if (snapshot.length === 0) {
    console.log(chalk.gray('   (no tables/collections found)'));
    return;
  }

  for (const item of snapshot) {
    if (dbType === 'mariadb') {
      const rowsLabel = item.rows === null ? 'unknown rows' : `~${item.rows.toLocaleString()} rows`;
      console.log(chalk.cyan(`\n📦 ${item.table}`) + chalk.gray(` (${item.engine || 'unknown engine'}, ${rowsLabel})`));
      const nameWidth = Math.max(...item.columns.map(c => c.name.length), 4);
      const typeWidth = Math.max(...item.columns.map(c => c.type.length), 4);
      for (const col of item.columns) {
        const name = col.name.padEnd(nameWidth);
        const type = col.type.padEnd(typeWidth);
        const nullable = col.nullable ? 'NULL    ' : 'NOT NULL';
        const key = col.key ? chalk.yellow(col.key) : '';
        console.log(`   ${chalk.white(name)}  ${chalk.gray(type)}  ${nullable}  ${key}`);
      }
    } else {
      console.log(chalk.cyan(`\n📦 ${item.collection}`) + chalk.gray(` (~${item.count.toLocaleString()} docs)`));
      if (item.indexes.length > 0) {
        console.log(chalk.gray(`   indexes: ${item.indexes.join(', ')}`));
      }
      if (item.fields.length === 0) {
        console.log(chalk.gray('   (empty collection — no sample document to infer shape from)'));
      } else {
        const nameWidth = Math.max(...item.fields.map(f => f.name.length), 4);
        for (const f of item.fields) {
          console.log(`   ${chalk.white(f.name.padEnd(nameWidth))}  ${chalk.gray(f.type)}`);
        }
      }
    }
  }
  console.log('');
}

/**
 * Pretty-print a schema diff (from diffSchemaSnapshots()) — what actually
 * changed between two snapshots, git-diff style, instead of two full listings
 * a reader has to compare by hand.
 */
function printSchemaDiff(diff, dbType) {
  if (isDiffEmpty(diff)) {
    console.log(chalk.gray('   (schema unchanged)'));
    return;
  }

  const label = dbType === 'mariadb' ? { one: 'table', many: 'tables' } : { one: 'collection', many: 'collections' };
  const fieldLabel = dbType === 'mariadb' ? 'column' : 'field';

  for (const item of diff.added) {
    const name = item.table ?? item.collection;
    console.log(chalk.green(`+ 📦 ${name}`) + chalk.gray(` (new ${label.one})`));
  }
  for (const item of diff.removed) {
    const name = item.table ?? item.collection;
    console.log(chalk.red(`- 📦 ${name}`) + chalk.gray(` (${label.one} removed)`));
  }
  for (const c of diff.changed) {
    const total = c.addedFields.length + c.removedFields.length + c.changedFields.length;
    console.log(chalk.yellow(`~ 📦 ${c.name}`) + chalk.gray(` (${total} ${fieldLabel}${total === 1 ? '' : 's'} changed)`));
    for (const f of c.addedFields) {
      console.log(chalk.green(`   + ${f.name.padEnd(20)}`) + chalk.gray(` ${f.type}${f.nullable === false ? ' NOT NULL' : ''}`));
    }
    for (const f of c.removedFields) {
      console.log(chalk.red(`   - ${f.name}`));
    }
    for (const f of c.changedFields) {
      const beforeDesc = f.before.type ?? '';
      const afterDesc = f.after.type ?? '';
      console.log(chalk.yellow(`   ~ ${f.name.padEnd(20)}`) + chalk.gray(` ${beforeDesc} → ${afterDesc}`));
    }
  }
  if (diff.unchangedCount > 0) {
    console.log(chalk.gray(`\n   Unchanged: ${diff.unchangedCount} ${diff.unchangedCount === 1 ? label.one : label.many}`));
  }
}

/**
 * Pretty-print a DCL diff (from DCLIdempotentChecker.diffStates()) — which
 * accounts/roles were added or dropped, and which permissions changed on
 * accounts that still exist, git-diff style. Covers both a straight DROP
 * USER (shows up as removedUsers) and a REVOKE that leaves the account in
 * place (shows up as removedGrants/removedRoles on an unchanged user) --
 * a rename isn't detected as such, it shows up as one removed + one added
 * account, since a dropped-then-recreated name and an actual rename aren't
 * distinguishable from state alone.
 */
function printDCLDiff(diff, dbType) {
  if (dbType === 'mariadb') {
    const { addedUsers, removedUsers, addedGrants, removedGrants } = diff;
    if (addedUsers.length === 0 && removedUsers.length === 0 && addedGrants.length === 0 && removedGrants.length === 0) {
      console.log(chalk.gray('   (no account/permission changes)'));
      return;
    }
    for (const u of addedUsers) console.log(chalk.green(`+ 👤 ${u}`) + chalk.gray(' (new account)'));
    for (const u of removedUsers) console.log(chalk.red(`- 👤 ${u}`) + chalk.gray(' (account dropped)'));
    // Grants on accounts that were newly added/removed are implied by the
    // account line above -- only show grant-level detail for accounts that
    // still exist on both sides, so an account rename doesn't also spam a
    // dozen redundant "+ GRANT .../- GRANT ..." lines.
    const addedUsersSet = new Set(addedUsers);
    const removedUsersSet = new Set(removedUsers);
    const grantsToShow = (grants, isAdded) => grants.filter(g => isAdded ? !addedUsersSet.has(g.user) : !removedUsersSet.has(g.user));
    for (const g of grantsToShow(addedGrants, true)) console.log(chalk.green(`   + ${g.grant}`) + chalk.gray(` (${g.user})`));
    for (const g of grantsToShow(removedGrants, false)) console.log(chalk.red(`   - ${g.grant}`) + chalk.gray(` (${g.user})`));
    return;
  }

  if (dbType === 'mongodb') {
    const { addedUsers, removedUsers, changedUsers, addedRoles, removedRoles } = diff;
    if (addedUsers.length === 0 && removedUsers.length === 0 && changedUsers.length === 0 && addedRoles.length === 0 && removedRoles.length === 0) {
      console.log(chalk.gray('   (no account/permission changes)'));
      return;
    }
    for (const u of addedUsers) console.log(chalk.green(`+ 👤 ${u.user}@${u.db}`) + chalk.gray(` (new account, roles: ${u.roles.join(', ') || 'none'})`));
    for (const u of removedUsers) console.log(chalk.red(`- 👤 ${u.user}@${u.db}`) + chalk.gray(' (account dropped)'));
    for (const c of changedUsers) {
      console.log(chalk.yellow(`~ 👤 ${c.user}@${c.db}`) + chalk.gray(' (roles changed)'));
      for (const r of c.addedRoles) console.log(chalk.green(`   + ${r}`));
      for (const r of c.removedRoles) console.log(chalk.red(`   - ${r}`));
    }
    for (const r of addedRoles) console.log(chalk.green(`+ 🔑 ${r.role}@${r.db}`) + chalk.gray(' (new custom role)'));
    for (const r of removedRoles) console.log(chalk.red(`- 🔑 ${r.role}@${r.db}`) + chalk.gray(' (custom role dropped)'));
    return;
  }

  console.log(chalk.gray(`   (DCL diff not supported for ${dbType})`));
}

/**
 * Build the context object RepeatableRunner / DCLIdempotentChecker expect.
 * `extra` can add fields like `validator` that only some call sites need.
 */
function buildDCLContext(adapter, migrationsDir, extra = {}) {
  return {
    dbType: adapter.dbType,
    connection: adapter.connection,
    db: adapter.db,
    client: adapter.client,
    migrationsDir,
    ...extra
  };
}

/**
 * Capture the current accounts/permissions state for whichever adapter type
 * is connected, via DCLIdempotentChecker's existing state-capture logic
 * (originally built for idempotency verification, reused here for
 * before/after diffing around a `dcl` run).
 */
async function captureDCLState(checker, adapter, config) {
  if (adapter.dbType === 'mariadb') {
    const dbConfig = adapter.config.mariadb || adapter.config;
    return checker.captureMariaDBState(adapter.connection, dbConfig.database || config.database);
  }
  return checker.captureMongoDBState(adapter.db);
}

/**
 * Execute one DCL (repeatable) migration file's content once, without any
 * checksum bookkeeping. Used by the read-only verification/dry paths
 * (dcl:verify, validate-all, test-all, dcl:verify-all) that need to actually
 * run a script to observe its effect, but don't go through
 * RepeatableRunner.run()'s normal checksum-tracked apply flow.
 */
async function executeDCLFile(adapter, runner, file) {
  if (adapter.dbType === 'mariadb') {
    await adapter.connection.query(file.content);
    return;
  }
  if (adapter.dbType === 'mongodb') {
    const { resolved, generated } = runner.resolvePlaceholderPasswords(file.content, file.fileName);
    let mod;
    if (generated) {
      const baseName = file.fileName.replace(/\.js$/, '.mjs');
      const tmpPath = path.join(os.tmpdir(), `dcl-exec-${crypto.randomBytes(8).toString('hex')}-${baseName}`);
      await fs.writeFile(tmpPath, resolved, 'utf-8');
      mod = await import(`file://${tmpPath}`);
      await fs.unlink(tmpPath).catch(() => {});
    } else {
      mod = await import(`file://${file.filePath}?t=${Date.now()}`);
    }
    if (typeof mod.up === 'function') {
      await mod.up(adapter.db, adapter.client, mongodbHelpers);
    }
  }
}

/**
 * Auto-create placeholder tables for table-level GRANTs so DCL scripts that
 * reference not-yet-existing tables can still be exercised for verification.
 * MariaDB only; no-op for MongoDB or when there are no DCL files.
 */
async function scaffoldDCLPlaceholders(adapter, files) {
  if (adapter.dbType !== 'mariadb' || files.length === 0) return;
  const { DCLScaffold } = await import('./core/dcl-scaffold.js');
  const scaffold = new DCLScaffold();
  const scaffoldResult = await scaffold.scaffoldForDCL(
    adapter.connection,
    files.map(f => f.content),
    { verbose: false }
  );
  if (scaffoldResult.tables.length > 0) {
    console.log(chalk.gray(`   [scaffold] Created ${scaffoldResult.tables.length} placeholder table(s): ${scaffoldResult.tables.join(', ')}`));
  }
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
          if (sr.success && sr.skipped) {
            console.log(chalk.gray(`   ⏭️  ${sr.file}: SKIPPED (no sanity blocks)`));
          } else if (sr.success) {
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

// ─────────────────────────────────────────────────────────────────
// sync: status -> up -> report -> show real current schema.
// Refuses (as an error, not a silent no-op) when there's nothing pending.
// ─────────────────────────────────────────────────────────────────

program
  .command('sync')
  .description('status -> up -> report what changed -> show the real current schema. Errors out if nothing is pending.')
  .option('--sanity-check', 'Enable sanity check (pre-check, post-check, auto-rollback)')
  .option('--no-auto-rollback', 'Disable auto-rollback on sanity check failure')
  .option('--target <migration>', 'Run migrations up to and including this migration')
  .option('--only <migration>', 'Run only this specific migration')
  .option('-o, --output <dir>', 'Save a JSON+HTML report to this directory (sync-report-<timestamp>.{json,html})')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    const startedAt = Date.now();
    let adapter;

    const saveReportIfRequested = async (reportData) => {
      if (!options.output) return;
      const report = buildSyncReport({ ...reportData, durationMs: Date.now() - startedAt });
      try {
        const files = await saveSyncReport(options.output, report);
        console.log(chalk.gray(`\n📄 Report saved: ${files.join(', ')}`));
      } catch (reportError) {
        console.error(chalk.red(`\n[ERROR] Failed to save report: ${reportError.message}`));
      }
    };

    try {
      adapter = await getAdapter(options);
      const dbConfig = adapter.config.mariadb || adapter.config.mongodb || adapter.config;
      const databaseName = dbConfig.database || dbConfig.databaseName;

      if (options.sanityCheck) {
        adapter.config.sanityCheck = {
          ...adapter.config.sanityCheck,
          enabled: true,
          autoRollback: options.autoRollback !== false,
          verbose: true
        };
      }

      await adapter.connect();

      console.log(chalk.blue(`\n[SYNC] ${adapter.dbType} — checking status...`));
      const status = await adapter.status();

      if (status.pending.length === 0) {
        console.error(chalk.red(`\n❌ [SYNC] Nothing to update — 0 pending migrations.`));
        console.error(chalk.gray(`   Database is already at the latest applied migration (${status.applied.length} applied total).`));
        console.error(chalk.gray(`   Stopping here — this is treated as an error, not a silent success.`));
        await saveReportIfRequested({ dbType: adapter.dbType, database: databaseName, status: 'no-pending', pending: [] });
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan(`\n   ${status.pending.length} pending migration(s):`));
      for (const f of status.pending) {
        console.log(`   ⏳ ${f}`);
      }

      // Snapshot before applying anything, so the schema section afterward
      // can show what actually changed instead of just the final state.
      const supportsSchema = typeof adapter.getSchemaSnapshot === 'function';
      const beforeSnapshot = supportsSchema ? await adapter.getSchemaSnapshot() : null;

      console.log(chalk.blue(`\n[SYNC] Applying...`));
      const migrationOptions = { target: options.target, only: options.only, verbose: true };

      let result;
      if (options.sanityCheck && typeof adapter.upWithSanityCheck === 'function') {
        result = await adapter.upWithSanityCheck(migrationOptions);
      } else {
        result = await adapter.up(migrationOptions);
      }

      if (result.errors.length > 0) {
        console.error(chalk.red(`\n❌ [SYNC] Failed — stopping before schema snapshot:`));
        for (const e of result.errors) {
          console.error(`   ${e}`);
        }
        if (result.applied.length > 0) {
          console.error(chalk.yellow(`\n   ${result.applied.length} migration(s) DID apply before the failure:`));
          for (const m of result.applied) console.error(`   ✅ ${m}`);
        }
        await saveReportIfRequested({
          dbType: adapter.dbType, database: databaseName, status: 'failed',
          pending: status.pending, applied: result.applied, errors: result.errors
        });
        process.exitCode = 1;
        return;
      }

      console.log(chalk.green(`\n✅ [SYNC] Applied ${result.applied.length} migration(s):`));
      for (const m of result.applied) {
        console.log(`   ✅ ${m}`);
      }

      let snapshot = null;
      let diff = null;
      if (supportsSchema) {
        snapshot = await adapter.getSchemaSnapshot();
        diff = diffSchemaSnapshots(beforeSnapshot, snapshot);

        console.log(chalk.blue(`\n[SYNC] Schema changes (${adapter.dbType}):`));
        console.log(chalk.gray('─'.repeat(60)));
        printSchemaDiff(diff, adapter.dbType);
        console.log(chalk.gray('─'.repeat(60)));

        console.log(chalk.blue(`\n[SYNC] Current schema (${adapter.dbType}):`));
        console.log(chalk.gray('─'.repeat(60)));
        printSchemaSnapshot(snapshot, adapter.dbType);
        console.log(chalk.gray('─'.repeat(60)));
        console.log(chalk.gray(`Total: ${snapshot.length} ${adapter.dbType === 'mariadb' ? 'table(s)' : 'collection(s)'}`));
      } else {
        console.log(chalk.gray(`\n[SYNC] Schema snapshot not supported for ${adapter.dbType}.`));
      }

      await saveReportIfRequested({
        dbType: adapter.dbType, database: databaseName, status: 'applied',
        pending: status.pending, applied: result.applied, schema: snapshot, schemaDiff: diff
      });
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
      const appliedSet = new Set(status.applied.map(m => {
        if (m.fileName) return m.fileName.replace('.sql', '').replace('.js', '');
        if (m.id) return m.id;
        if (m.name) return m.name;
        return m;
      }));
      
      // Determine which files to mark
      let filesToMark = [];
      
      if (options.all) {
        filesToMark = versionedFiles;
      } else if (options.upTo) {
        const targetFile = versionedFiles.find(f => f.includes(options.upTo));
        if (!targetFile) {
          console.error(chalk.red(`[ERROR] Migration '${options.upTo}' not found`));
          process.exitCode = 1;
          return; // let the finally block below close the connection
        }
        const targetIdx = versionedFiles.indexOf(targetFile);
        filesToMark = versionedFiles.slice(0, targetIdx + 1);
      } else if (options.file) {
        const targetFile = versionedFiles.find(f => f.includes(options.file));
        if (!targetFile) {
          console.error(chalk.red(`[ERROR] Migration '${options.file}' not found`));
          process.exitCode = 1;
          return; // let the finally block below close the connection
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

// ─────────────────────────────────────────────────────────────────
// reset: Delete all changelog/checksum tracking records
// ─────────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Delete all changelog/checksum records — does NOT run down() and does NOT touch schema/data')
  .option('--yes', 'Actually perform the deletion (omit for a dry-run count only)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;

    try {
      adapter = await getAdapter(options);
      await adapter.connect();

      const config = await loadConfig(options.config);
      const isRepeatable = config.mode === 'repeatable';

      let tableLabel;
      let resetArgs;
      if (isRepeatable) {
        // Reuse RepeatableRunner's constructor validation for the checksum table/collection name
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(config)
        });
        tableLabel = runner.checksumTable;
        resetArgs = adapter.dbType === 'mongodb'
          ? { collectionName: runner.checksumTable }
          : { tableName: runner.checksumTable };
      } else {
        tableLabel = adapter.dbType === 'mongodb' ? adapter.changelogCollection : adapter.changelogTable;
        resetArgs = {};
      }

      console.log(chalk.blue(`\n[RESET] ${adapter.dbType} / mode=${config.mode || 'versioned'} / table=${tableLabel}`));

      const dryCount = await adapter.resetChangelog({ ...resetArgs, dryRun: true });

      if (!options.yes) {
        console.log(chalk.yellow(`\n⚠️  DRY RUN: would delete ${dryCount} record(s) from '${tableLabel}'.`));
        console.log(chalk.gray(`   This only clears tracking records — it does NOT run down() and does NOT touch any actual tables/collections.`));
        console.log(chalk.gray(`   After a reset, the next 'up'/'dcl' will try to re-apply everything from scratch —`));
        console.log(chalk.gray(`   only do this if the underlying schema/data is also being reset (e.g. a throwaway dev/test database).`));
        console.log(chalk.gray(`   Re-run with --yes to actually delete.`));
        return;
      }

      const deletedCount = await adapter.resetChangelog({ ...resetArgs, dryRun: false });
      console.log(chalk.red(`\n🗑️  Deleted ${deletedCount} record(s) from '${tableLabel}'.`));
      console.log(chalk.gray(`   Next 'status'/'up'/'dcl' will treat all migrations as pending again.`));
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
      } else {
        console.log(chalk.green('\n✅ All migrations are valid!'));
      }
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

// ─────────────────────────────────────────────────────────────────
// validate-all: Validate all DDL and DCL in a directory
// ─────────────────────────────────────────────────────────────────

program
  .command('validate-all')
  .description('Validate all DDL and DCL migrations in a directory (e.g., production-server)')
  .argument('<dir>', 'Directory path (e.g., databases/mariadb/production-server)')
  .option('--allow-dangerous', 'Allow dangerous operations (🟠 level)')
  .option('--allow-forbidden', 'Allow forbidden operations (🔴 level) - requires team approval')
  .option('--allow <codes>', 'Allow specific operation codes (comma-separated)', (val) => val.split(','))
  .option('--ddl-only', 'Validate DDL migrations only')
  .option('--dcl-only', 'Validate DCL migrations only')
  .action(async (dirPath, cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    
    try {
      const absDir = path.resolve(dirPath);
      
      console.log(chalk.blue(`\n[VALIDATE-ALL] Scanning directory: ${dirPath}`));
      console.log(chalk.gray('═'.repeat(60)));
      
      // Build validation options
      const validateOptions = {
        allowDangerous: options.allowDangerous,
        allowForbidden: options.allowForbidden,
        allowedCodes: options.allow || []
      };
      
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
      
      // Find all config files
      const configs = [];
      
      // Scan for DDL configs (databases in ddl/ subdirectories)
      if (!options.dclOnly) {
        const ddlDir = path.join(absDir, 'ddl');
        try {
          const ddlExists = await fs.stat(ddlDir);
          if (ddlExists.isDirectory()) {
            const ddlSubdirs = await fs.readdir(ddlDir);
            for (const subdir of ddlSubdirs) {
              const configPath = path.join(ddlDir, subdir, 'config.js');
              try {
                await fs.stat(configPath);
                configs.push({
                  type: 'DDL',
                  label: `DDL/${subdir}`,
                  path: configPath
                });
              } catch {
                // config.js not found, skip
              }
            }
          }
        } catch {
          // ddl/ directory not found
        }
      }

      // Scan for DCL config
      if (!options.ddlOnly) {
        const dclConfigPath = path.join(absDir, 'dcl', 'config.js');
        try {
          await fs.stat(dclConfigPath);
          configs.push({
            type: 'DCL',
            label: 'DCL',
            path: dclConfigPath
          });
        } catch {
          // dcl/config.js not found
        }
      }
      
      if (configs.length === 0) {
        console.log(chalk.yellow('\n⚠️  No config files found in the specified directory.'));
        console.log(chalk.gray('   Expected structure: <dir>/ddl/*/config.js or <dir>/dcl/config.js'));
        process.exitCode = 1;
        return;
      }
      
      console.log(chalk.cyan(`\n📋 Found ${configs.length} config(s):`));
      for (const cfg of configs) {
        console.log(chalk.gray(`   - ${cfg.label}`));
      }
      console.log('');
      
      let totalPassed = 0;
      let totalFailed = 0;
      const results = [];
      
      // Validate each config
      for (const cfg of configs) {
        console.log(chalk.blue(`\n${'─'.repeat(60)}`));
        console.log(chalk.bold.cyan(`📦 ${cfg.label}`));
        console.log(chalk.gray(`   Config: ${cfg.path}`));
        console.log(chalk.blue('─'.repeat(60)));
        
        let adapter;
        try {
          // Load config
          const config = await loadConfig(cfg.path);
          config.migrationsDir = resolveMigrationsDir(config, cfg.path);

          adapter = await createAdapter(config);
          
          if (cfg.type === 'DDL') {
            // Validate DDL migrations
            console.log(chalk.blue(`\n[VALIDATE] Checking migrations (${adapter.dbType})...\n`));
            
            const result = await adapter.validate(validateOptions);

            if (result.error) {
              console.log(chalk.red(`[ERROR] ${result.error}`));
            }
            
            for (const fileResult of result.results) {
              if (fileResult.valid) {
                console.log(chalk.green(`[OK] ${fileResult.file}`));
                totalPassed++;
              } else {
                console.log(chalk.red(`[ERROR] ${fileResult.file}`));
                totalFailed++;
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
                }
              }

              // Show structural errors (syntax errors, orphan drops, FK errors, etc.)
              const shownOps = new Set([
                ...(fileResult.forbiddenOps || []),
                ...(fileResult.dangerousOps || [])
              ]);
              const structuralErrors = (fileResult.errors || []).filter(e => !shownOps.has(e));
              for (const err of structuralErrors) {
                console.log(chalk.red(`   🔴 [${err.code || 'ERROR'}] ${err.message}`));
              }
              
              // Show summary for this file
              if (fileResult.summary && (fileResult.summary.forbidden > 0 || fileResult.summary.dangerous > 0 || fileResult.summary.structural > 0)) {
                const s = fileResult.summary;
                console.log(chalk.gray(`   📊 structural:${s.structural} forbidden:${s.forbidden} dangerous:${s.dangerous} warnings:${s.warnings}`));
              }
            }
            
            const passed = result.results.filter(r => r.valid).length;
            const failed = result.results.filter(r => !r.valid).length;
            console.log(chalk.gray(`\nTotal: ${result.results.length} | Valid: ${passed} | Invalid: ${failed}`));
            
            results.push({
              label: cfg.label,
              type: 'DDL',
              valid: result.valid,
              total: result.results.length,
              passed,
              failed
            });
            
          } else if (cfg.type === 'DCL') {
            // Verify DCL idempotency
            console.log(chalk.blue(`\n[DCL VERIFY] Checking idempotency (${adapter.dbType})...\n`));
            
            // Connect to database for DCL verification
            await adapter.connect();
            
            // config.migrationsDir was already resolved to an absolute path above
            const migrationsDir = config.migrationsDir;

            const runner = new RepeatableRunner({
              checksumTable: resolveChecksumTable(config)
            });
            
            const checker = new DCLIdempotentChecker({
              verbose: false  // Disable verbose output for validate-all
            });
            
            const context = buildDCLContext(adapter, migrationsDir);

            const files = await runner.getRepeatableFiles(migrationsDir);
            let allPassed = true;
            let passedCount = 0;
            let failedCount = 0;

            await scaffoldDCLPlaceholders(adapter, files);

            for (const file of files) {
              console.log(chalk.blue(`📄 ${file.fileName}`));
              
              const executeScript = () => executeDCLFile(adapter, runner, file);
              
              const result = await checker.verify(context, executeScript, {
                database: config.database || config.mongodb?.databaseName,
                scriptName: file.fileName
              });
              
              if (result.success) {
                console.log(chalk.green(`   ✅ IDEMPOTENT`));
                passedCount++;
                totalPassed++;
              } else {
                console.log(chalk.red(`   ❌ NOT IDEMPOTENT: ${result.error}`));
                allPassed = false;
                failedCount++;
                totalFailed++;
              }
            }
            
            console.log(chalk.gray(`\nTotal: ${files.length} | Passed: ${passedCount} | Failed: ${failedCount}`));
            
            results.push({
              label: cfg.label,
              type: 'DCL',
              valid: allPassed,
              total: files.length,
              passed: passedCount,
              failed: failedCount
            });
          }
          
        } catch (error) {
          console.error(chalk.red(`\n[ERROR] ${error.message}`));
          totalFailed++;
          
          results.push({
            label: cfg.label,
            type: cfg.type,
            valid: false,
            error: error.message
          });
        } finally {
          if (adapter) {
            try {
              await adapter.disconnect();
            } catch {
              // Ignore disconnect errors
            }
          }
        }
      }
      
      // Final summary
      console.log(chalk.blue(`\n${'═'.repeat(60)}`));
      console.log(chalk.bold.white('📊 SUMMARY'));
      console.log(chalk.blue('═'.repeat(60)));
      
      for (const res of results) {
        const icon = res.valid ? '✅' : '❌';
        const color = res.valid ? chalk.green : chalk.red;
        
        if (res.error) {
          console.log(color(`${icon} ${res.label} (${res.type}): ERROR - ${res.error}`));
        } else {
          console.log(color(`${icon} ${res.label} (${res.type}): ${res.passed}/${res.total} passed`));
        }
      }
      
      console.log(chalk.blue('─'.repeat(60)));
      console.log(chalk.cyan(`Total Configs: ${configs.length}`));
      console.log(chalk.green(`Total Passed: ${totalPassed} file(s)`));
      console.log(chalk.red(`Total Failed: ${totalFailed} file(s)`));
      
      const allValid = results.every(r => r.valid);
      
      if (allValid) {
        console.log(chalk.green.bold('\n🎉 All validations passed!'));
        process.exitCode = 0;
      } else {
        console.log(chalk.red.bold('\n❌ Some validations failed!'));
        process.exitCode = 1;
      }
      
    } catch (error) {
      console.error(chalk.red(`\n[ERROR] ${error.message}`));
      if (error.stack) console.error(chalk.gray(error.stack));
      process.exitCode = 1;
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
    
    const runTest = async ({ name, adapter }) => {
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
  .option('--pattern <pattern>', 'Glob pattern to match config files, relative to --base-dir or cwd (e.g., "project/**/config.js")')
  .option('--base-dir <dir>', 'Base directory for pattern search (default: current working directory)')
  .option('--console-only', 'Only output to console, do not save report files')
  .option('--sanity-check', 'Run PreCheck/PostCheck sanity checks for DDL migrations (requires sanity sections in migration files)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    const reporter = new Reporter();
    reporter.start();
    
    let configFiles = [];
    
    if (options.pattern) {
      // Use pattern to find config files
      const effectiveBaseDir = options.baseDir
        ? path.resolve(options.baseDir)
        : process.cwd();

      if (options.baseDir) {
        console.log(chalk.blue(`\n📁 Base directory: ${effectiveBaseDir}`));
      }
      console.log(chalk.blue(`\n🔍 Searching for configs matching pattern: ${options.pattern}\n`));
      
      // Helper function to recursively find config.js files
      const findConfigFiles = async (dir, pattern) => {
        const results = [];
        const baseDir = path.resolve(dir);
        
        // Parse pattern to extract directory and file matching
        const patternParts = pattern.split('/');
        let searchDir = baseDir;
        let patternIndex = 0;
        
        // Build the search directory from non-wildcard parts
        // Exclude the last part if it's config.js (filename, not directory)
        const maxIndex = patternParts[patternParts.length - 1] === 'config.js' 
          ? patternParts.length - 1 
          : patternParts.length;
        
        while (patternIndex < maxIndex && !patternParts[patternIndex].includes('*')) {
          searchDir = path.join(searchDir, patternParts[patternIndex]);
          patternIndex++;
        }
        
        // Recursively search from the search directory
        const searchRecursive = async (currentDir, depth = 0) => {
          if (depth > 10) return; // Prevent infinite recursion
          
          try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            
            for (const entry of entries) {
              if (entry.name.startsWith('_')) continue; // Skip template directories
              
              const fullPath = path.join(currentDir, entry.name);

              if (entry.isDirectory()) {
                await searchRecursive(fullPath, depth + 1);
              } else if (entry.name === 'config.js') {
                // Check if this config.js matches the pattern
                const configRelativePath = path.relative(baseDir, fullPath);
                
                if (options.pattern.includes('*')) {
                  // Wildcard matching (supports both * and **)
                  // Use placeholder to avoid double replacement
                  const patternRegex = options.pattern
                    .replace(/\*\*/g, '___DOUBLESTAR___')
                    .replace(/\*/g, '[^/]*')
                    .replace(/___DOUBLESTAR___/g, '.*')
                    .replace(/\//g, '\\/');
                  
                  if (new RegExp(`^${patternRegex}$`).test(configRelativePath)) {
                    results.push(fullPath);
                  }
                } else {
                  // Exact match
                  if (configRelativePath === options.pattern) {
                    results.push(fullPath);
                  }
                }
              }
            }
          } catch {
            // Directory not accessible, skip
          }
        };
        
        await searchRecursive(searchDir);
        return results;
      };
      
      configFiles = await findConfigFiles(effectiveBaseDir, options.pattern);
      
      if (configFiles.length === 0) {
        console.log(chalk.yellow('⚠️  No config files found matching the pattern.'));
        process.exit(1);
      }
      
      console.log(chalk.cyan(`Found ${configFiles.length} config file(s):`));
      for (const cf of configFiles) {
        console.log(chalk.gray(`   - ${path.relative(effectiveBaseDir, cf)}`));
      }
      console.log('');
      
    } else {
      // Original logic: Find all database configs
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
              configFiles.push(configPath);
            } catch {
              continue; // No config file
            }
          }
        } catch {
          // Directory doesn't exist, skip
        }
      }
    }
    
    // Run tests for each config file
    for (const configPath of configFiles) {
      const relativePath = path.relative(process.cwd(), configPath);
      let dbType = configPath.includes('mongodb') ? 'mongodb' : 'mariadb';

      // Detect if this is a DCL or DDL config
      const isDCL = configPath.includes('/dcl/');

      let baseConfig;
      try {
        baseConfig = await loadConfig(configPath);
      } catch (error) {
        reporter.addResult({
          database: relativePath,
          dbType,
          testType: 'connection',
          success: false,
          duration: 0,
          error: `Failed to load config: ${error.message}`
        });
        continue;
      }

      if (!baseConfig.migrationsDir) {
        baseConfig.migrationsDir = path.resolve(path.dirname(configPath), 'migrations');
      } else if (!path.isAbsolute(baseConfig.migrationsDir)) {
        baseConfig.migrationsDir = path.resolve(path.dirname(configPath), baseConfig.migrationsDir);
      }
      // Prefer type from config.js; fall back to path-based detection
      if (baseConfig.type) {
        dbType = baseConfig.type;
      } else {
        baseConfig.type = dbType;
      }

      // Expand multi-instance configs into individual per-instance runs
      const instanceList = (baseConfig.instances && Array.isArray(baseConfig.instances))
        ? baseConfig.instances.map(instance => {
            const ic = { ...baseConfig };
            if (instance.mongodb) ic.mongodb = instance.mongodb;
            if (instance.mariadb) ic.mariadb = instance.mariadb;
            delete ic.instances;
            return { config: ic, label: `${relativePath} [${instance.name || 'instance'}]` };
          })
        : [{ config: baseConfig, label: relativePath }];

      for (const { config, label } of instanceList) {
        let adapter;

        try {
          adapter = createAdapter(config);
          await adapter.connect();

          if (isDCL) {
            // ═══════════════════════════════════════════════════════
            // DCL: Content Validate + DCLIdempotentChecker per-file
            // ═══════════════════════════════════════════════════════

            // Step 1: Content validate (forbidden-ops: dclReverse, dclHighRisk)
            console.log(chalk.blue(`\n[VALIDATE] ${label} (${dbType})...`));
            const validateStart = Date.now();

            const runner = new RepeatableRunner({
              checksumTable: resolveChecksumTable(config)
            });

            const context = buildDCLContext(adapter, config.migrationsDir);

            let validateSuccess = true;
            let validateError = null;
            let dclFiles = [];

            try {
              dclFiles = await runner.getRepeatableFiles(config.migrationsDir);
              if (dclFiles.length === 0) {
                console.log(chalk.yellow(`   ⚠️  No DCL migrations found`));
              } else {
                // Content validate via adapter (dclReverse + dclHighRisk rules)
                const validateResult = await adapter.validate();
                if (validateResult.valid) {
                  console.log(chalk.gray(`   ✅ ${dclFiles.length} DCL migration(s) found, content valid`));
                } else {
                  validateSuccess = false;
                  const errCount = validateResult.results.filter(r => !r.valid).length;
                  validateError = `${errCount} file(s) failed content validation`;
                  console.log(chalk.red(`   ❌ ${validateError}`));
                  for (const r of validateResult.results.filter(r => !r.valid)) {
                    console.log(chalk.red(`      [ERROR] ${r.file}`));
                    for (const op of (r.forbiddenOps || [])) {
                      console.log(chalk.red(`         ❌ [${op.code}] ${op.message}`));
                    }
                  }
                }
              }
            } catch (error) {
              validateSuccess = false;
              validateError = error.message;
              console.log(chalk.red(`   ❌ Validation failed: ${error.message}`));
            }

            reporter.addResult({
              database: label,
              dbType,
              testType: 'validate',
              success: validateSuccess,
              duration: Date.now() - validateStart,
              error: validateError
            });

            if (!validateSuccess) {
              continue; // Skip idempotency test if content validation fails
            }

            // Step 2: DCLIdempotentChecker — per-file state comparison (run×2 + diff)
            console.log(chalk.blue(`\n[TEST] ${label} (${dbType}) DCL Idempotency...`));

            await scaffoldDCLPlaceholders(adapter, dclFiles);

            const checker = new DCLIdempotentChecker({ verbose: false });

            for (const file of dclFiles) {
              const fileStart = Date.now();
              console.log(chalk.gray(`   📄 ${file.fileName}`));

              const executeScript = () => executeDCLFile(adapter, runner, file);

              const idempotencyResult = await checker.verify(context, executeScript, {
                database: config.database || config.mongodb?.databaseName,
                scriptName: file.fileName
              });

              if (idempotencyResult.success) {
                console.log(chalk.green(`      ✅ IDEMPOTENT`));
              } else {
                console.log(chalk.red(`      ❌ NOT IDEMPOTENT: ${idempotencyResult.error}`));
              }

              reporter.addResult({
                database: `${label} [${file.fileName}]`,
                dbType,
                testType: 'dcl-idempotency',
                success: idempotencyResult.success,
                duration: Date.now() - fileStart,
                error: idempotencyResult.success ? null : idempotencyResult.error
              });
            }

          } else {
            // ═══════════════════════════════════════════════════════
            // DDL: Validate + Up-Down-Up Test
            // ═══════════════════════════════════════════════════════

            // Run validation
            console.log(chalk.blue(`\n[VALIDATE] ${label} (${dbType})...`));
            const validateStart = Date.now();
            const validateResult = await adapter.validate();
            reporter.addResult({
              database: label,
              dbType,
              testType: 'validate',
              success: validateResult.valid,
              duration: Date.now() - validateStart,
              error: validateResult.valid ? null : 'Validation failed'
            });

            // Run Up-Down-Up test
            console.log(chalk.blue(`\n[TEST] ${label} (${dbType}) Up-Down-Up...`));
            const testResult = await adapter.runUpDownUpTest();
            reporter.addResult({
              database: label,
              dbType,
              testType: 'up-down-up',
              success: testResult.success,
              duration: testResult.duration,
              error: testResult.error || null
            });

            // ═══════════════════════════════════════════════════════
            // DDL: Sanity Check (optional, requires --sanity-check flag)
            // ═══════════════════════════════════════════════════════
            if (options.sanityCheck && typeof adapter.upWithSanityCheck === 'function') {
              console.log(chalk.blue(`\n[SANITY] ${label} (${dbType}) PreCheck/PostCheck...`));
              console.log(chalk.cyan(`   Sanity Check: ENABLED`));

              // Reset DB to clean state (down all), then re-run with sanity checks
              const statusAfterTest = await adapter.status();
              const appliedCount = statusAfterTest.applied.length;
              if (appliedCount > 0) {
                await adapter.down(appliedCount);
              }

              const sanityStart = Date.now();
              const sanityRunResult = await adapter.upWithSanityCheck({ verbose: false });

              // Report per-migration sanity results
              for (const sr of (sanityRunResult.sanityResults || [])) {
                const skipped = sr.skipped === true;
                if (skipped) {
                  console.log(chalk.gray(`   ⏭️  ${sr.file}: SKIPPED (no sanity blocks)`));
                } else if (sr.success) {
                  console.log(chalk.green(`   ✅ ${sr.file}: PASSED`));
                } else {
                  console.log(chalk.red(`   ❌ ${sr.file}: FAILED — ${sr.error}`));
                  if (sr.rolledBack) console.log(chalk.yellow(`      ↩️  Auto-rolled back`));
                }

                if (!skipped) {
                  reporter.addResult({
                    database: `${label} [${sr.file}]`,
                    dbType,
                    testType: 'sanity-check',
                    success: sr.success,
                    duration: Date.now() - sanityStart,
                    error: sr.success ? null : sr.error
                  });
                }
              }

              // Overall sanity summary if no per-file results (e.g. all skipped)
              if ((sanityRunResult.sanityResults || []).filter(sr => !sr.skipped).length === 0) {
                console.log(chalk.yellow(`   ⚠️  No sanity blocks found in any migration (add -- +sanity PreCheck/PostCheck sections)`));
              }
            }
          }

        } catch (error) {
          reporter.addResult({
            database: label,
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
    }
    
    reporter.end();
    reporter.printConsoleReport();
    
    // Save reports (unless --console-only is specified)
    if (!options.consoleOnly) {
      const files = await reporter.saveReport(options.output, 'all');
      console.log(chalk.gray(`\n📁 Reports saved to:`));
      for (const f of files) {
        console.log(`   ${f}`);
      }
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
      const migrationsDir = resolveMigrationsDir(config, options.config);
      
      const runner = new RepeatableRunner({
        checksumTable: resolveChecksumTable(config)
      });
      
      // validator is only passed through when --validate is enabled
      const context = buildDCLContext(adapter, migrationsDir, {
        validator: options.validate ? adapter : null
      });

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

      // Snapshot accounts/permissions before applying, so we can show what
      // actually changed afterward instead of just "N migrations applied".
      const dclChecker = new DCLIdempotentChecker({ verbose: false });
      const beforeDCLState = await captureDCLState(dclChecker, adapter, config);

      const result = await runner.run(context);

      if (result.applied.length > 0) {
        console.log(chalk.green(`\n✅ Applied ${result.applied.length} DCL migration(s):`));
        for (const m of result.applied) {
          const annotationInfo = m.annotations?.allowDangerous ? chalk.yellow(' [allow-dangerous]') : '';
          console.log(`   ${m.fileName} (${m.reason})${annotationInfo}`);
        }

        const afterDCLState = await captureDCLState(dclChecker, adapter, config);
        const dclDiff = dclChecker.diffStates(beforeDCLState, afterDCLState, adapter.dbType);
        console.log(chalk.blue(`\n[DCL] Account/permission changes (${adapter.dbType}):`));
        console.log(chalk.gray('─'.repeat(60)));
        printDCLDiff(dclDiff, adapter.dbType);
        console.log(chalk.gray('─'.repeat(60)));
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
      const migrationsDir = resolveMigrationsDir(config, options.config);
      
      const runner = new RepeatableRunner({
        checksumTable: resolveChecksumTable(config)
      });
      
      const context = buildDCLContext(adapter, migrationsDir);
      
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
      const migrationsDir = resolveMigrationsDir(config, options.config);
      
      const runner = new RepeatableRunner({
        checksumTable: resolveChecksumTable(config)
      });
      
      const checker = new DCLIdempotentChecker({
        verbose: config.idempotencyCheck?.verbose ?? true
      });
      
      const context = buildDCLContext(adapter, migrationsDir);
      
      console.log(chalk.blue(`\n[DCL VERIFY] Testing idempotency (${adapter.dbType})...\n`));
      console.log(chalk.gray('═'.repeat(50)));
      
      const files = await runner.getRepeatableFiles(migrationsDir);
      let allPassed = true;

      await scaffoldDCLPlaceholders(adapter, files);

      for (const file of files) {
        console.log(chalk.blue(`\n📄 ${file.fileName}`));
        
        const executeScript = () => executeDCLFile(adapter, runner, file);
        
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

// ─────────────────────────────────────────────────────────────────
// DCL Multi-Instance Commands
// ─────────────────────────────────────────────────────────────────

program
  .command('dcl-all')
  .description('Run DCL repeatable migrations on all instances')
  .option('--dry-run', 'Show what would be run without executing')
  .option('--validate', 'Enable validation before running')
  .option('--allow-dangerous', 'Allow dangerous operations when validating')
  .option('--allow-forbidden', 'Allow forbidden operations when validating')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    const config = await loadConfig(options.config);
    const migrationsDir = resolveMigrationsDir(config, options.config);
    
    console.log(chalk.blue(`\n🔐 Running DCL migrations on ${adapters.length} instance(s)...\n`));
    
    let hasErrors = false;
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(config)
        });
        
        const context = buildDCLContext(adapter, migrationsDir, {
          validator: options.validate ? adapter : null
        });
        
        if (options.dryRun) {
          const status = await runner.status(context);
          console.log(chalk.blue(`\n[${name}] Would apply ${status.pending.length} DCL migration(s)`));
          for (const p of status.pending) {
            console.log(chalk.gray(`   - ${p.fileName} (${p.reason})`));
          }
        } else {
          console.log(chalk.blue(`\n[${name}] Running DCL migrations...`));
          const result = await runner.run(context);
          
          if (result.applied.length > 0) {
            console.log(chalk.green(`   ✅ Applied ${result.applied.length} DCL migration(s)`));
            for (const m of result.applied) {
              console.log(chalk.gray(`      - ${m.fileName} (${m.reason})`));
            }
          } else {
            console.log(chalk.gray(`   All DCL migrations are up-to-date.`));
          }
          
          if (result.skipped && result.skipped.length > 0) {
            console.log(chalk.yellow(`   ⏭️  Skipped ${result.skipped.length} migration(s) due to validation`));
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
  .command('dcl:status-all')
  .description('Show DCL repeatable migration status for all instances')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    const config = await loadConfig(options.config);
    const migrationsDir = resolveMigrationsDir(config, options.config);
    
    console.log(chalk.blue(`\n📊 DCL Status for ${adapters.length} instance(s):\n`));
    console.log(chalk.gray('═'.repeat(60)));
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(config)
        });
        
        const context = buildDCLContext(adapter, migrationsDir);
        
        const status = await runner.status(context);
        
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType})`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.yellow(`  ⏳ Pending: ${status.pending.length}`));
        console.log(chalk.green(`  ✅ Up-to-date: ${status.upToDate.length}`));
        
        if (status.pending.length > 0) {
          for (const p of status.pending) {
            console.log(chalk.gray(`     - ${p.fileName} (${p.reason})`));
          }
        }
        
      } catch (error) {
        console.log(chalk.blue(`\n[${name}]`));
        console.log(chalk.red(`  ❌ Error: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
    }
    
    console.log(chalk.gray('\n' + '═'.repeat(60)));
  });

program
  .command('dcl:verify-all')
  .description('Verify DCL scripts are idempotent on all instances')
  .action(async (cmdOptions, cmd) => {
    const options = cmd.parent.opts();
    
    let adapters;
    try {
      adapters = await getAdapters(options);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    const config = await loadConfig(options.config);
    const migrationsDir = resolveMigrationsDir(config, options.config);
    
    console.log(chalk.blue(`\n🔍 Verifying DCL idempotency on ${adapters.length} instance(s)...\n`));
    console.log(chalk.gray('═'.repeat(60)));
    
    let allPassed = true;
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(config)
        });
        
        const checker = new DCLIdempotentChecker({
          verbose: config.idempotencyCheck?.verbose ?? true
        });
        
        const context = buildDCLContext(adapter, migrationsDir);
        
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType})`));
        console.log(chalk.gray('─'.repeat(40)));
        
        const files = await runner.getRepeatableFiles(migrationsDir);
        
        for (const file of files) {
          console.log(chalk.blue(`  📄 ${file.fileName}`));
          
          const executeScript = () => executeDCLFile(adapter, runner, file);
          
          const result = await checker.verify(context, executeScript, {
            database: config.database || adapter.config?.mariadb?.database,
            scriptName: file.fileName
          });
          
          if (result.success) {
            console.log(chalk.green(`     ✅ IDEMPOTENT`));
          } else {
            console.log(chalk.red(`     ❌ NOT IDEMPOTENT: ${result.error}`));
            allPassed = false;
          }
        }
        
      } catch (error) {
        allPassed = false;
        console.log(chalk.blue(`\n[${name}]`));
        console.log(chalk.red(`  ❌ Error: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
    }
    
    console.log(chalk.gray('\n' + '═'.repeat(60)));
    
    if (allPassed) {
      console.log(chalk.green('\n✅ All DCL scripts are idempotent on all instances!'));
    } else {
      console.log(chalk.red('\n❌ Some DCL scripts failed idempotency check!'));
      process.exitCode = 1;
    }
  });

program.parse();
