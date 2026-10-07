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
import { Reporter, buildSyncReport, saveSyncReport, pruneSyncReports, buildNotificationEmail, notificationEmailToHTML, saveNotificationEmail, buildDCLNotificationEvents, buildMultiInstanceSummary, multiInstanceSummaryToHTML, partialApplyNote, newRunId } from './core/reporter.js';
import { diffSchemaSnapshots, isDiffEmpty } from './core/schema-diff.js';
import { RepeatableRunner, mongodbHelpers } from './core/repeatable-runner.js';
import { DCLIdempotentChecker } from './core/dcl-idempotent-checker.js';
import { checkMigrationsToRun, describeValidationFailures, allowHintForFailures } from './core/validation-gate.js';
import { parseExpectedErrors, checkFileExpectation, parseExpectedSanity, checkSanityExpectation } from './core/fixture-expectations.js';
import { buildDCLPlan } from './core/dcl-plan.js';
import { resolveDirs, describeDirs, pickDir, matchMigrationFile } from './core/migration-dirs.js';
import fs from 'fs/promises';
import path from 'path';

const program = new Command();

program
  .name('db-migrate')
  .description('Unified database migration tool for MongoDB and MariaDB/MySQL (supports multiple instances, DDL versioned and DCL repeatable modes)')
  .version('3.0.1')
  .option('-c, --config <path>', 'Path to config file')
  .option('-t, --type <type>', 'Database type (mongodb, mariadb)');

/**
 * Resolve a config's migrationsDir to an absolute path, relative to the
 * directory the config file itself lives in. Returns the value unchanged if
 * not set. DCL configs may give a list of directories (each one resolved);
 * DDL configs may not (see core/migration-dirs.js).
 */
function resolveMigrationsDir(config, configPath, migrationsDir = config.migrationsDir) {
  const configDir = path.dirname(path.resolve(configPath));
  return resolveDirs(migrationsDir, configDir, config.mode);
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
async function getAdapter(options, { readOnly = false } = {}) {
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

  const adapter = createAdapter(config);
  // Read-only commands (status, --dry-run, --plan) never create the
  // changelog/checksum table or the database, so they work with a
  // SELECT-only account and leave the database exactly as it was.
  adapter.readOnly = readOnly;
  return adapter;
}

/**
 * Load config and create multiple adapters for multi-instance configs
 */
async function getAdapters(options, { readOnly = false } = {}) {
  if (!options.config) {
    console.error(chalk.red('[ERROR] Config file is required (-c or --config)'));
    process.exit(1);
  }

  const config = await loadConfig(options.config);
  config.migrationsDir = resolveMigrationsDir(config, options.config);

  // Handle instances - resolve their migrationsDir too
  if (config.instances) {
    for (const instance of config.instances) {
      if (instance.migrationsDir) {
        instance.migrationsDir = resolveMigrationsDir({ ...config, ...instance }, options.config, instance.migrationsDir);
      } else if (config.migrationsDir) {
        instance.migrationsDir = config.migrationsDir;
      }
    }
  }

  // Override type if provided
  if (options.type) {
    config.type = options.type;
  }

  const adapters = createAdapters(config);
  for (const { adapter } of adapters) adapter.readOnly = readOnly;
  return adapters;
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
 * Enrich adapter.up()/upWithSanityCheck() result.errors with rollback status
 * for the notification email — result.errors alone says a migration's
 * postCheck failed, not whether auto-rollback actually recovered the
 * database or itself failed and left a half-applied migration behind. The
 * latter needs a human right away; the former is a normal, self-healed
 * failure. Both adapters push { file|fileName, success, error, rolledBack }
 * onto result.sanityResults for every checked migration (only present when
 * --sanity-check was used) — non-sanity errors (syntax errors, a plain up()
 * failure) pass through unchanged since they have no sanityResults entry.
 */
function formatDDLFailureDetails(result) {
  if (!result.sanityResults || result.sanityResults.length === 0) return result.errors;
  const rollbackByFile = new Map(
    result.sanityResults.filter(r => !r.success).map(r => [r.file ?? r.fileName, r.rolledBack])
  );
  return result.errors.map(e => {
    const file = e.split(':')[0];
    if (!rollbackByFile.has(file)) return e;
    const rolledBack = rollbackByFile.get(file);
    return `${e} (${rolledBack ? 'auto-rolled back' : 'ROLLBACK FAILED — manual intervention required'})`;
  });
}

/**
 * Print any newly-adopted checksum baselines from status() — informational,
 * never blocks. A checksum-less row means this changelog entry predates
 * checksum tracking; status() already adopted the current file content as
 * the trusted baseline as a side effect of computing this.
 */
function printChecksumBaseline(status) {
  if (status.checksumBaselined && status.checksumBaselined.length > 0) {
    console.log(chalk.gray(`\n📌 Adopted checksum baseline for ${status.checksumBaselined.length} previously-unchecksummed migration(s):`));
    for (const f of status.checksumBaselined) console.log(chalk.gray(`   ${f}`));
  }
}

/**
 * Print any checksum mismatches from status() — an already-applied migration
 * file whose content no longer matches what was recorded when it was
 * applied. Display-only (used by `status`, which never blocks); `up`/`sync`
 * use enforceChecksumGate() below instead.
 */
function printChecksumMismatches(status) {
  if (status.checksumMismatches && status.checksumMismatches.length > 0) {
    console.log(chalk.red(`\n🔴 Checksum mismatch — ${status.checksumMismatches.length} already-applied migration(s) were edited after being applied:`));
    for (const m of status.checksumMismatches) {
      console.log(chalk.red(`   ${m.fileName} (applied ${m.appliedAt})`));
    }
  }
}

/**
 * The actual gate: refuses to let `up`/`sync` proceed past an already-applied
 * migration file that's been edited since it ran — the database's real
 * history may no longer match what's in these files, and layering more
 * migrations on top of an unknown starting point is exactly the kind of risk
 * DDL-PRODUCTION-SAFETY.md exists to avoid. `--allow-checksum-drift` is the
 * explicit, logged override: it re-reads each mismatched file and accepts
 * its current content as the new baseline (via adapter.repairChecksum()) —
 * without that, every subsequent run would keep re-flagging the same,
 * already-reviewed drift forever.
 */
async function enforceChecksumGate(status, adapter, options) {
  printChecksumBaseline(status);
  if (!status.checksumMismatches || status.checksumMismatches.length === 0) return;

  printChecksumMismatches(status);

  if (!options.allowChecksumDrift) {
    throw new Error(
      `${status.checksumMismatches.length} already-applied migration file(s) no longer match what was recorded at apply time — the database's real history may not match these files. ` +
      `Investigate before proceeding. If the edit was intentional (e.g. a comment/typo fix), rerun with --allow-checksum-drift to accept the current content as the new checksum baseline.`
    );
  }

  console.log(chalk.yellow(`\n⚠️  --allow-checksum-drift: accepting current content as the checksum baseline for ${status.checksumMismatches.length} file(s)`));
  for (const m of status.checksumMismatches) {
    await adapter.repairChecksum(m.fileName);
    console.log(chalk.yellow(`   ✓ ${m.fileName}`));
  }
}

/**
 * Print + enforce the other two Gate R1 checks — unlike checksum drift,
 * neither has a CLI override. A changelog row with no matching file, or
 * applied migrations that aren't a contiguous prefix of the sorted file
 * list, both mean the changelog's own bookkeeping no longer matches
 * reality closely enough for this tool to safely reason about what's
 * "pending" — that needs a human to look at the changelog table/collection
 * directly, not a flag to wave through. See docs/RUNTIME-GATE-PLAN.md Gate R1.
 */
function printChangelogConsistency(status) {
  const orphaned = status.orphanedChangelogEntries || [];
  const outOfOrder = status.outOfOrderApplied || [];
  // Informational, never blocking: R__ files are not versioned migrations.
  const ignoredFiles = status.ignoredRepeatableFiles || [];
  const ignoredEntries = status.ignoredRepeatableEntries || [];
  if (ignoredFiles.length > 0) {
    console.log(chalk.yellow(`\n⚠️  Ignoring ${ignoredFiles.length} R__ file(s) in this versioned directory — repeatable (DCL) migrations belong in a DCL project (mode: 'repeatable'): ${ignoredFiles.join(', ')}`));
  }
  if (ignoredEntries.length > 0) {
    console.log(chalk.yellow(`⚠️  The changelog has ${ignoredEntries.length} R__ entr${ignoredEntries.length === 1 ? 'y' : 'ies'} from an older version that ran R__ files as versioned migrations — left untouched and ignored: ${ignoredEntries.join(', ')}`));
  }
  if (orphaned.length > 0) {
    console.log(chalk.red(`\n🔴 Orphaned changelog entries — ${orphaned.length} row(s) recorded as applied have no matching file on disk:`));
    for (const o of orphaned) {
      console.log(chalk.red(`   ${o.id} (applied ${o.appliedAt})`));
    }
  }
  if (outOfOrder.length > 0) {
    console.log(chalk.red(`\n🔴 Out-of-order changelog — ${outOfOrder.length} migration(s) are applied but sort AFTER a still-pending one:`));
    for (const f of outOfOrder) {
      console.log(chalk.red(`   ${f}`));
    }
  }
  return orphaned.length > 0 || outOfOrder.length > 0;
}

function enforceChangelogConsistencyGate(status) {
  const hasIssues = printChangelogConsistency(status);
  if (!hasIssues) return;

  const orphaned = status.orphanedChangelogEntries || [];
  const outOfOrder = status.outOfOrderApplied || [];
  throw new Error(
    `Changelog is inconsistent with the migration files on disk (${orphaned.length} orphaned entr${orphaned.length === 1 ? 'y' : 'ies'}, ${outOfOrder.length} out-of-order). ` +
    `This usually means a file was deleted or renamed after being applied, or migrations were applied out of order. ` +
    `No override for this — inspect the changelog table/collection directly and fix the mismatch (or use 'baseline'/manual edits) before proceeding.`
  );
}

/**
 * Pretty-print a schema diff (from diffSchemaSnapshots()) — what actually
 * changed between two snapshots, git-diff style, instead of two full listings
 * a reader has to compare by hand.
 */
/**
 * The pre-run validation gate (see src/core/validation-gate.js): the same
 * rules as `validate`, applied to exactly the migrations about to run.
 * Throws before anything executes if any of them fails. Allowances that were
 * used (CLI flags or a file's @allow annotations) are printed, so the run log
 * records what was let through.
 *
 * @param {boolean} [opts.report] - dry-run: print the outcome, set a failing
 *   exit code, but don't throw
 */
async function enforceValidationGate(adapter, status, options, { report = false } = {}) {
  const gate = await checkMigrationsToRun(adapter, status.pending, options);
  if (gate.error) throw new Error(gate.error);
  if (gate.files.length === 0) return gate;

  if (options.allowDangerous) console.log(chalk.yellow('   🟠 --allow-dangerous given: dangerous operations will be allowed'));
  if (options.allowForbidden) console.log(chalk.red('   🔴 --allow-forbidden given: forbidden operations will be allowed (REQUIRES APPROVAL)'));
  if (options.allow && options.allow.length > 0) console.log(chalk.cyan(`   📋 --allow given: ${options.allow.join(', ')}`));
  for (const w of gate.configWarnings || []) console.log(chalk.yellow(`   ⚠️  ${w}`));
  for (const a of gate.allowed) {
    const approver = a.forbidden ? ` — approved by ${a.approvedBy || '(nobody recorded)'}` : '';
    console.log(chalk.yellow(`   ⚠️  Allowed in ${a.file}${a.code ? ` [${a.code}]` : ''}: ${a.message.replace(/^.*?\[(?:FORCE )?ALLOWED\]\s*/, '')}${approver}`));
  }

  if (gate.failures.length === 0) {
    console.log(chalk.green(`\n🛡️  Validation passed for the ${gate.files.length} migration(s) about to run.`));
    return gate;
  }

  console.error(chalk.red(`\n🛡️  Validation failed — ${report ? 'this run would be refused' : 'nothing was applied'}:`));
  for (const f of gate.failures) {
    console.error(chalk.red(`   ❌ ${f.file}`));
    for (const m of f.messages) console.error(chalk.red(`      ${m}`));
  }
  const hint = allowHintForFailures(gate.failures);
  if (hint.needsFix) {
    console.error(chalk.gray('   Some of these can only be fixed in the migration file itself.'));
  }
  if (hint.allow) {
    const marker = adapter.dbType === 'mongodb' ? '//' : '--';
    console.error(chalk.gray(`   If reviewed and intended, allow them explicitly: add "${marker} @allow: ${hint.allow}" at the top of the file, or rerun with --allow ${hint.allow}`));
  }
  if (report) {
    process.exitCode = 1;
    return gate;
  }
  throw new Error(`Validation failed — nothing was applied: ${describeValidationFailures(gate.failures).join('; ')}`);
}

/**
 * Pre-execution runtime gates (docs/RUNTIME-GATE-PLAN.md), right before
 * anything executes:
 *   R2 — long-open transactions / metadata-lock waits on this database:
 *        refuses unless --allow-open-transactions (logged with a timestamp);
 *        with runtimeGates.requireLockCheck, also refuses when the check
 *        couldn't run (missing privilege)
 *   R3 — read-only target: refuses, no override (connect to the primary)
 *   R4 — disk/binlog headroom, replication lag, and (for `files`) index
 *        builds / bulk writes on large MongoDB collections, ALTERs / bulk
 *        DML on large MariaDB tables: warnings only
 * Checks that couldn't run (privileges, server type) are listed as skipped.
 *
 * @param {{ locks?: boolean, disk?: boolean, report?: boolean }} [opts] -
 *   locks/disk: run R2/R4 (DDL commands; `dcl` only needs R3);
 *   report: dry-run — print, set a failing exit code, don't throw
 */
async function enforceRuntimeGates(adapter, options, { locks = true, disk = true, report = false, files = [] } = {}) {
  if (typeof adapter.runtimePreflight !== 'function') return;
  const r = await adapter.runtimePreflight({ locks, disk });
  // Index builds / bulk writes (MongoDB: large collections) and ALTERs /
  // bulk DML (MariaDB: large tables) among the migrations about to run
  // (advisory)
  for (const check of ['largeCollectionWarnings', 'largeTableWarnings']) {
    if (typeof adapter[check] !== 'function' || files.length === 0) continue;
    const large = await adapter[check](files);
    r.warnings.push(...large.warnings);
    r.skipped.push(...large.skipped);
  }

  for (const sk of r.skipped) console.log(chalk.gray(`   ℹ️  Skipped ${sk}`));
  for (const w of r.warnings) console.log(chalk.yellow(`   ⚠️  ${w}`));

  const refuse = (message) => {
    if (report) {
      console.error(chalk.red(`   ❌ This run would be refused: ${message}`));
      process.exitCode = 1;
      return;
    }
    throw new Error(message);
  };

  // R2 couldn't run (privilege) and the project says it must
  const lockCheckSkipped = locks ? r.skipped.find(sk => sk.startsWith('R2 ')) : null;
  if (lockCheckSkipped && adapter.getRuntimeGateConfig().requireLockCheck) {
    if (options.allowOpenTransactions && !report) {
      console.log(chalk.yellow(`   ⚠️  [${new Date().toISOString()}] --allow-open-transactions: proceeding without the R2 check runtimeGates.requireLockCheck asks for`));
    } else {
      refuse(`R2: the open-transaction / lock check could not run, and runtimeGates.requireLockCheck is on — ` +
        `grant the migration account ${adapter.dbType === 'mongodb' ? 'the clusterMonitor role (inprog privilege)' : 'the PROCESS privilege'}, ` +
        'or rerun with --allow-open-transactions if you have checked the database yourself.');
      if (report) return;
    }
  }

  if (r.readOnly) {
    refuse(`R3: ${resolveTargetLabel(adapter)} is read-only (${r.readOnly.reason}) — migrations must run against the writable primary. ` +
      'No override: writing to a read-only node either fails midway or, for privileged accounts, makes a replica diverge.');
    if (report) return;
  }

  const blockers = [...r.openTransactions, ...r.metadataLockWaits];
  if (blockers.length > 0) {
    const cfg = adapter.getRuntimeGateConfig();
    console.log(chalk.red(`\n🔴 R2: ${blockers.length} session(s) on ${resolveTargetLabel(adapter)} could block this migration's DDL:`));
    for (const t of r.openTransactions) {
      console.log(chalk.red(`   ${t.id}  open ${t.durationSec}s  ${t.who}  ${t.query}`));
    }
    for (const w of r.metadataLockWaits) {
      console.log(chalk.red(`   ${w.id}  waiting ${w.durationSec}s on "${w.state}"  ${w.who}  ${w.query}`));
    }
    console.log(chalk.gray(`   (transactions open longer than runtimeGates.longTransactionSec = ${cfg.longTransactionSec}s, and sessions waiting on a metadata lock)`));
    if (options.allowOpenTransactions && !report) {
      console.log(chalk.yellow(`   ⚠️  [${new Date().toISOString()}] --allow-open-transactions: proceeding anyway — the Lock Guard still bounds how long each statement waits`));
    } else {
      refuse('R2: open transactions or metadata-lock waits could make this migration queue behind them and block every later query on the table. ' +
        'Let them finish (or end them), or rerun with --allow-open-transactions if you know they are safe.');
    }
  }
}

/**
 * " [shared]" after a DCL file name when migrationsDir lists several
 * directories — which one the file is in; '' for a single directory.
 */
function dirTag(entry, multiDir) {
  return multiDir && entry.dir ? chalk.gray(` [${path.basename(entry.dir)}]`) : '';
}

/** Print a `dcl --plan` (see src/core/dcl-plan.js). */
function printDCLPlan(plan, label) {
  console.log(chalk.blue(`\n[DCL PLAN] ${label} — nothing is executed`));
  if (plan.files.length === 0) {
    console.log(chalk.gray(`   All ${plan.upToDate} DCL script(s) are up to date — a run would change nothing.`));
  }
  for (const f of plan.files) {
    console.log(chalk.cyan(`\n   📄 ${f.fileName} (${f.reason})`) + dirTag(f, plan.multiDir));
    if (f.diffNote) console.log(chalk.gray(`      ${f.diffNote}`));
    if (f.diff) {
      for (const d of f.diff) {
        const text = `      ${d.op} ${d.line}`;
        console.log(d.op === '+' ? chalk.green(text) : d.op === '-' ? chalk.red(text) : chalk.gray(text));
      }
    }
    if (f.accounts.length === 0) {
      console.log(chalk.gray('      (no account names found in the script — it may build them at runtime)'));
    }
    for (const a of f.accounts) {
      const state = a.exists === null ? `could not check (${a.error})` : a.exists ? 'exists' : 'does not exist';
      console.log(`      👤 ${a.account}${a.statement ? ` [${a.statement}]` : ''}: ${state}`);
      if (a.exists && a.grants.length) for (const g of a.grants) console.log(chalk.gray(`         now: ${g}`));
      if (a.password) console.log(chalk.yellow(`         🔑 ${a.password}`));
    }
  }
  printOrphanedDCL(plan.orphaned);
}

/** R1 (DCL): checksum records whose script is gone. */
function printOrphanedDCL(orphaned) {
  if (!orphaned || orphaned.length === 0) return;
  console.log(chalk.red(`\n🔴 ${orphaned.length} DCL script(s) were applied but are no longer on disk — whatever they created (accounts, grants) is still in the database:`));
  for (const o of orphaned) console.log(chalk.red(`   ${o.fileName} (applied ${o.appliedAt})`));
}

/**
 * R1 (DCL) gate: refuse while applied scripts are missing from disk, unless
 * --accept-removed-dcl confirms the removal was intended — which then drops
 * their checksum records (bookkeeping only; accounts are untouched).
 */
async function enforceRemovedDCLGate(runner, context, options) {
  const { orphaned } = await runner.status(context);
  if (!orphaned || orphaned.length === 0) return;
  printOrphanedDCL(orphaned);
  if (!options.acceptRemovedDcl) {
    throw new Error('Applied DCL script(s) missing from disk — deleted or renamed after being applied? Restore them, or if removing them was intended ' +
      '(and the accounts/grants they created are handled), rerun with --accept-removed-dcl to forget them.');
  }
  await runner.forgetChecksums(context, orphaned.map(o => o.fileName));
  console.log(chalk.yellow(`   ⚠️  [${new Date().toISOString()}] --accept-removed-dcl: forgot ${orphaned.length} removed script(s) — accounts and grants were not touched`));
}

/** The --allow* options shared by validate and the commands it gates. */
function addAllowOptions(command) {
  return command
    .option('--allow-dangerous', 'Allow dangerous operations (🟠 level)')
    .option('--allow-forbidden', 'Allow forbidden operations (🔴 level) - requires team approval')
    .option('--allow <codes>', 'Allow specific operation codes (comma-separated)', (val) => val.split(','))
    .option('--approved-by <name>', 'Who approved the forbidden operations this run allows (recorded in the run log and notification email)');
}

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
 * Best-effort project label for the notification email header -- the
 * database/schema name this config targets, same fallback chain
 * captureDCLState() uses to find it.
 */
function resolveProjectLabel(adapter, config) {
  if (adapter.dbType === 'mariadb') {
    const dbConfig = adapter.config.mariadb || adapter.config;
    return dbConfig.database || config.database || 'unknown';
  }
  return config.mongodb?.databaseName || adapter.config.mongodb?.databaseName || 'unknown';
}

/**
 * Which server a run hit — "host:port · db <name>" — for the notification
 * email header. Instances often share a database name (one `app` database per
 * region), so the database alone can't tell their emails apart. Credentials in
 * a MongoDB URL are never included.
 */
function resolveTargetLabel(adapter) {
  if (adapter.dbType === 'mariadb') {
    const dbConfig = adapter.config.mariadb || adapter.config;
    const server = `${dbConfig.host || 'localhost'}:${dbConfig.port || 3306}`;
    return dbConfig.database ? `${server} · db ${dbConfig.database}` : server;
  }
  const mongo = adapter.config.mongodb || {};
  // mongodb[+srv]://[user:pass@]host1[:port][,host2…][/db][?opts] → host list only
  const server = (mongo.url || '').replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0];
  return [server, mongo.databaseName && `db ${mongo.databaseName}`].filter(Boolean).join(' · ') || null;
}

/**
 * Each instance's notification email is written to a file named after the
 * instance, so two instances sharing a name would silently overwrite each
 * other's generated passwords. Refuse that up front, before connecting.
 */
function assertUniqueInstanceNames(adapters) {
  const seen = new Set();
  for (const { name } of adapters) {
    const fileName = instanceNotificationFileName(name);
    if (seen.has(fileName)) {
      throw new Error(`Instance name '${name}' is used more than once (or only differs in characters not allowed in a file name). ` +
        `Give every entry in 'instances' a unique name — each instance's notification email is written to ${fileName}.`);
    }
    seen.add(fileName);
  }
}

/** Forbidden operations a DCL run let through (dcl --validate), with who approved each. */
function printDCLApprovals(approvals, indent = '   ') {
  for (const a of approvals || []) {
    console.log(chalk.yellow(`${indent}⚠️  Allowed in ${a.file} [${a.code}] — approved by ${a.approvedBy || '(nobody recorded)'}`));
  }
}

/** saveNotificationEmail() options from config (notifications.keepRuns). */
function notificationOptions(config, extra = {}) {
  return { keepRuns: config?.notifications?.keepRuns, ...extra };
}

function printNotificationCleanup(saved, what = 'notification') {
  if (saved.removed?.length) console.log(chalk.gray(`   🧹 Removed ${saved.removed.length} older ${what} cop${saved.removed.length === 1 ? 'y' : 'ies'} (notifications.keepRuns)`));
  if (saved.warning) console.log(chalk.yellow(`   ⚠️  ${saved.warning}`));
}

function instanceNotificationFileName(name) {
  return `notification-${String(name).replace(/[^A-Za-z0-9._-]/g, '_')}.html`;
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

// Files already warned about getting a throwaway password (see executeDCLFile()).
const throwawayPasswordWarned = new Set();

/**
 * Execute one DCL (repeatable) migration file's content once, without any
 * checksum bookkeeping. Used by the read-only verification/dry paths
 * (dcl:verify, validate-all, test-all, dcl:verify-all) that need to actually
 * run a script to observe its effect, but don't go through
 * RepeatableRunner.run()'s normal checksum-tracked apply flow.
 */
async function executeDCLFile(adapter, runner, file) {
  // The placeholder is always resolved, to a throwaway password nobody sees:
  // run as-is, CREATE USER … IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN' leaves a
  // real account whose password is that publicly-known literal — and a later
  // `dcl` run would then report it as "already existed, password unchanged".
  const { resolved, generated } = runner.resolvePlaceholderPasswords(file.content, file.fileName);
  if (generated && !throwawayPasswordWarned.has(file.filePath)) {
    throwawayPasswordWarned.add(file.filePath); // verify runs each file twice; warn once
    console.log(chalk.yellow(`     ⚠️  Accounts this check creates get a throwaway password (not recorded anywhere). ` +
      `Run verification against a scratch database, or rotate those accounts' passwords afterwards.`));
  }

  if (adapter.dbType === 'mariadb') {
    await adapter.connection.query(resolved);
    return;
  }
  if (adapter.dbType === 'mongodb') {
    const mod = generated
      ? await runner.importResolvedModule(resolved, file.fileName)
      : await import(`file://${file.filePath}?t=${Date.now()}`);
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
      adapter = await getAdapter(options, { readOnly: true });
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

      printChecksumBaseline(status);
      printChecksumMismatches(status);
      if (status.checksumMismatches && status.checksumMismatches.length > 0) {
        console.log(chalk.gray(`   Run 'up'/'sync' to see this enforced, or with --allow-checksum-drift to accept it.`));
      }
      printChangelogConsistency(status);

      console.log('');
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

const upCommand = program
  .command('up')
  .description('Run pending migrations (validated first, like `validate`)')
  .option('--dry-run', 'Show what would be run without executing')
  .option('--sanity-check', 'Enable sanity check (pre-check, post-check, auto-rollback)')
  .option('--no-auto-rollback', 'Disable auto-rollback on sanity check failure')
  .option('--target <migration>', 'Run migrations up to and including this migration')
  .option('--only <migration>', 'Run only this specific migration')
  .option('--instance <name>', 'Run only on specified instance (for multi-instance configs)')
  .option('--allow-checksum-drift', 'Accept already-applied migration files whose content changed since being applied, as the new checksum baseline')
  .option('--allow-open-transactions', 'Run even if long-open transactions or metadata-lock waits are found on the database (runtime gate R2)');
addAllowOptions(upCommand)
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;

    try {
      adapter = await getAdapter(options, { readOnly: Boolean(options.dryRun) });

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
        printChecksumBaseline(status);
        printChecksumMismatches(status);
        printChangelogConsistency(status);
        const gate = await enforceValidationGate(adapter, status, options, { report: true });
        await enforceRuntimeGates(adapter, options, { report: true, files: gate.files });
        return;
      }

      const preflightStatus = await adapter.status();
      enforceChangelogConsistencyGate(preflightStatus);
      await enforceChecksumGate(preflightStatus, adapter, options);
      const gate = await enforceValidationGate(adapter, preflightStatus, options);
      if (preflightStatus.pending.length > 0) await enforceRuntimeGates(adapter, options, { files: gate.files });

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
      } else if (result.errors.length === 0 && !(result.sanityResults || []).some(sr => !sr.success)) {
        // nothing applied and nothing failed — otherwise the errors below say why
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
        console.error(chalk.yellow(`   ⚠️  ${partialApplyNote(adapter.dbType)}`));
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

const syncCommand = program
  .command('sync')
  .description('status -> validate -> up -> report what changed -> show the real current schema. Errors out if nothing is pending.')
  .option('--sanity-check', 'Enable sanity check (pre-check, post-check, auto-rollback)')
  .option('--no-auto-rollback', 'Disable auto-rollback on sanity check failure')
  .option('--target <migration>', 'Run migrations up to and including this migration')
  .option('--only <migration>', 'Run only this specific migration')
  .option('-o, --output <dir>', 'Save a JSON+HTML report to this directory (sync-report-<timestamp>.{json,html})')
  .option('--allow-checksum-drift', 'Accept already-applied migration files whose content changed since being applied, as the new checksum baseline')
  .option('--allow-open-transactions', 'Run even if long-open transactions or metadata-lock waits are found on the database (runtime gate R2)');
addAllowOptions(syncCommand)
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    const startedAt = Date.now();
    let adapter;
    let databaseName; // declared here (not inside try) so the catch block can still read it

    const saveReportIfRequested = async (reportData) => {
      if (!options.output) return;
      const report = buildSyncReport({ ...reportData, durationMs: Date.now() - startedAt });
      try {
        const files = await saveSyncReport(options.output, report);
        console.log(chalk.gray(`\n📄 Report saved: ${files.join(', ')}`));
        printNotificationCleanup(await pruneSyncReports(options.output, adapter?.config?.notifications?.keepRuns), 'sync report');
      } catch (reportError) {
        console.error(chalk.red(`\n[ERROR] Failed to save report: ${reportError.message}`));
      }
    };

    // Always writes, regardless of --sanity-check/-o for the report above —
    // this is the one file an external notifier can always expect to exist
    // after any sync attempt, success or failure, at a fixed known path.
    // `project`/`dbType` are passed explicitly rather than closed over,
    // because they aren't known until after the adapter connects below.
    const writeNotification = async (project, dbType, extra) => {
      const report = buildNotificationEmail({
        project,
        target: adapter ? resolveTargetLabel(adapter) : undefined,
        environment: process.env.DB_MIGRATE_ENVIRONMENT,
        dbType,
        ...extra
      });
      const saved = await saveNotificationEmail(options.output || 'reports', notificationEmailToHTML(report), undefined, notificationOptions(adapter?.config));
      console.log(chalk.gray(`\n   📧 Notification email written to ${saved.path} (latest copy: ${saved.latestPath})`));
      printNotificationCleanup(saved);
    };

    try {
      adapter = await getAdapter(options);
      const dbConfig = adapter.config.mariadb || adapter.config.mongodb || adapter.config;
      databaseName = dbConfig.database || dbConfig.databaseName;

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
      enforceChangelogConsistencyGate(status);
      await enforceChecksumGate(status, adapter, options);

      if (status.pending.length === 0) {
        console.error(chalk.red(`\n❌ [SYNC] Nothing to update — 0 pending migrations.`));
        console.error(chalk.gray(`   Database is already at the latest applied migration (${status.applied.length} applied total).`));
        console.error(chalk.gray(`   Stopping here — this is treated as an error, not a silent success.`));
        await saveReportIfRequested({ dbType: adapter.dbType, database: databaseName, status: 'no-pending', pending: [] });
        await writeNotification(databaseName, adapter.dbType, { status: 'skipped' });
        process.exitCode = 1;
        return;
      }

      console.log(chalk.cyan(`\n   ${status.pending.length} pending migration(s):`));
      for (const f of status.pending) {
        console.log(`   ⏳ ${f}`);
      }
      const gate = await enforceValidationGate(adapter, status, options);
      // Forbidden operations this run was allowed to execute, and who
      // approved each — the email's "Approved exceptions" section
      const approvals = gate.allowed.filter(a => a.forbidden).map(a => ({ file: a.file, code: a.code, approvedBy: a.approvedBy }));
      await enforceRuntimeGates(adapter, options, { files: gate.files });

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
        console.error(chalk.yellow(`   ⚠️  ${partialApplyNote(adapter.dbType)}`));
        if (result.applied.length > 0) {
          console.error(chalk.yellow(`\n   ${result.applied.length} migration(s) DID apply before the failure:`));
          for (const m of result.applied) console.error(`   ✅ ${m}`);
        }
        await saveReportIfRequested({
          dbType: adapter.dbType, database: databaseName, status: 'failed',
          pending: status.pending, applied: result.applied, errors: result.errors
        });
        await writeNotification(databaseName, adapter.dbType, {
          status: 'failed',
          // Failed while executing (not refused beforehand): the failing
          // migration itself may have run partway.
          ddl: { applied: result.applied, errors: formatDDLFailureDetails(result), partialRisk: true },
          approvals
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

      try {
        await writeNotification(databaseName, adapter.dbType, { ddl: { applied: result.applied, diff }, approvals });
      } catch (notifyError) {
        // The migrations DID apply — say so plainly instead of falling into
        // the generic failure path below (which would also write a
        // "failed" notification, if it could write anything at all).
        console.error(chalk.red(`\n❌ ${result.applied.length} migration(s) were applied successfully, but the notification email could not be written: ${notifyError.message}`));
        console.error(chalk.gray('   Nothing needs to be re-run — fix the output location (-o) for future runs.'));
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
      // Catches failures before the normal error-reporting above ever ran —
      // config didn't load, connect() failed, etc. Best-effort: this is the
      // one case where we may not even have a project/dbType yet, so this
      // must never itself throw and mask the real error.
      try {
        await writeNotification(
          databaseName || options.config || 'unknown',
          adapter?.dbType || 'unknown',
          { status: 'failed', ddl: { applied: [], errors: [error.message] } }
        );
      } catch (notifyError) {
        console.error(chalk.gray(`   (also failed to write failure notification: ${notifyError.message})`));
      }
    } finally {
      if (adapter) await adapter.disconnect();
    }
  });

program
  .command('down')
  .description('Rollback migrations (shows the plan and asks for confirmation first)')
  .option('-n, --count <number>', 'Number of migrations to rollback', '1')
  .option('--target <migration>', 'Rollback down to and including this migration')
  .option('--instance <name>', 'Run only on specified instance (for multi-instance configs)')
  .option('--dry-run', 'Show what would be rolled back, without doing it')
  .option('--yes', 'Skip the confirmation prompt (required when not running in a terminal)')
  .option('--allow-checksum-drift', 'Roll back migrations whose file was edited after being applied (their Down section may not be the reviewed one)')
  .option('--allow-open-transactions', 'Run even if long-open transactions or metadata-lock waits are found on the database (runtime gate R2)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options, { readOnly: Boolean(options.dryRun) });
      await adapter.connect();
      
      const count = parseInt(options.count, 10);
      if (!options.target && (!Number.isInteger(count) || count < 1)) {
        throw new Error(`--count must be a positive number (got '${options.count}')`);
      }
      const plan = await adapter.rollbackPlan({ count, target: options.target });
      if (plan.error) throw new Error(plan.error.replace(/^Target migration not found/, 'Target migration not found among applied migrations'));
      if (plan.files.length === 0) {
        console.log(chalk.gray('\n   No applied migrations to roll back.'));
        return;
      }

      const target = resolveTargetLabel(adapter);
      console.log(chalk.blue(`\n[DOWN] ${target} — ${options.dryRun ? 'would roll back' : 'rolling back'} ${plan.files.length} migration(s), most recent first:`));
      for (const f of plan.files) console.log(chalk.yellow(`   ⏪ ${f}`));
      console.log(chalk.gray('   Each runs its Down section, which usually drops tables/columns/collections and the data in them.'));

      if (plan.checksumMismatches.length > 0) {
        console.log(chalk.red(`\n🔴 ${plan.checksumMismatches.length} of these file(s) were edited after being applied: ${plan.checksumMismatches.join(', ')}`));
        if (!options.allowChecksumDrift) {
          throw new Error('Refusing to roll back with edited migration files — the Down section that would run is not the one that was applied with. ' +
            'Check the edit; if it is intended, rerun with --allow-checksum-drift.');
        }
        console.log(chalk.yellow('   ⚠️  --allow-checksum-drift: rolling back with the edited files'));
      }

      await enforceRuntimeGates(adapter, options, { report: Boolean(options.dryRun) });
      if (options.dryRun) return;

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new Error('down needs confirmation — not running in a terminal, so pass --yes to confirm (use --dry-run to only see the plan).');
        }
        const readline = await import('readline/promises');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(chalk.bold(`\nRoll back these ${plan.files.length} migration(s) on ${target}? Type "yes" to continue: `));
        rl.close();
        if (answer.trim().toLowerCase() !== 'yes') {
          console.log(chalk.gray('   Cancelled — nothing was rolled back.'));
          return;
        }
      }

      const result = await adapter.down(plan.files);
      
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
      // --dry-run only lists what would be marked: read-only, like the other previews
      adapter = await getAdapter(options, { readOnly: Boolean(options.dryRun) });
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
        const targetFile = matchMigrationFile(versionedFiles, options.upTo, '--up-to');
        if (!targetFile) {
          console.error(chalk.red(`[ERROR] Migration '${options.upTo}' not found`));
          process.exitCode = 1;
          return; // let the finally block below close the connection
        }
        const targetIdx = versionedFiles.indexOf(targetFile);
        filesToMark = versionedFiles.slice(0, targetIdx + 1);
      } else if (options.file) {
        const targetFile = matchMigrationFile(versionedFiles, options.file, '--file');
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
  .option('--dir <dir>', "Which directory to create it in, when migrationsDir lists several (e.g. 'shared' or 'prod-tw')")
  .action(async (name, cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options);
      
      const fileName = await adapter.createDCL(name, options.number, { dir: options.dir });
      console.log(chalk.green(`\n✅ Created: ${path.join(pickDir(adapter.config.migrationsDir, options.dir), fileName)}`));
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

const validateCommand = program
  .command('validate')
  .description('Validate migration files')
  .option('--pending-only', 'Only validate migrations not yet applied (connects to the database) — what up/sync will check');
addAllowOptions(validateCommand)
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options, { readOnly: true });
      
      // Build validation options
      const validateOptions = {
        allowDangerous: options.allowDangerous,
        allowForbidden: options.allowForbidden,
        allowedCodes: options.allow || [],
        approvedBy: options.approvedBy
      };

      // --pending-only: exactly what up/sync's validation gate checks.
      // Already-applied files ran under the rules of their day; judging them
      // again would push people to edit them, which the checksum gate rejects.
      if (options.pendingOnly) {
        await adapter.connect();
        const { pending } = await adapter.status();
        if (pending.length === 0) {
          console.log(chalk.green('\n✅ No pending migrations — nothing to validate.'));
          return;
        }
        validateOptions.files = pending;
      }
      
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

      if (result.error) {
        console.error(chalk.red(`[ERROR] Validation could not run: ${result.error}`));
        console.error(chalk.gray(`   migrationsDir: ${describeDirs(adapter.config.migrationsDir)}`));
        process.exitCode = 1;
        return;
      }
      if (result.ignoredRepeatableFiles && result.ignoredRepeatableFiles.length > 0) {
        console.log(chalk.yellow(`⚠️  Ignored ${result.ignoredRepeatableFiles.length} R__ file(s) — repeatable (DCL) migrations belong in a DCL project (mode: 'repeatable'), not a versioned one:`));
        for (const f of result.ignoredRepeatableFiles) console.log(chalk.yellow(`   - ${f}`));
        console.log('');
      }
      if (result.skippedFiles && result.skippedFiles.length > 0) {
        console.log(chalk.gray(`   (${result.skippedFiles.length} already-applied migration(s) not re-validated)\n`));
      }
      for (const w of result.configWarnings || []) console.log(chalk.yellow(`⚠️  ${w}`));
      
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
              console.log(chalk.gray(`      └─ Suggestion / 建議: ${op.suggestion}`));
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
        
        console.log(chalk.cyan('\n💡 If reviewed and intended, allow explicitly / 確認無誤後明確放行 — preferably with an annotation at the top of the file ("-- @allow: CODE" / "// @allow: CODE"), or:'));
        
        if (allDangerous.size > 0) {
          console.log(chalk.yellow(`   🟠 Dangerous / 危險操作: --allow-dangerous`));
          console.log(chalk.gray(`      or only these / 或只放行: --allow ${[...allDangerous].join(',')}`));
        }
        
        if (allForbidden.size > 0) {
          console.log(chalk.red(`   🔴 Forbidden / 禁止操作: --allow-forbidden (requires team approval / 需團隊審批)`));
          console.log(chalk.gray(`      or only these / 或只放行: --allow ${[...allForbidden].join(',')}`));
        }
        
        process.exitCode = 1;
      } else {
        console.log(chalk.green('\n✅ All migrations are valid!'));
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
    } finally {
      if (options.pendingOnly && adapter) await adapter.disconnect();
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
  .option('--approved-by <name>', 'Who approved the forbidden operations this run allows')
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
        allowedCodes: options.allow || [],
        approvedBy: options.approvedBy
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
      adapters = await getAdapters(options, { readOnly: true });
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

const upAllCommand = program
  .command('up-all')
  .description('Run pending migrations on all instances (each validated first, like `up`)')
  .option('--dry-run', 'Show what would be run without executing')
  .option('--allow-checksum-drift', 'Accept already-applied migration files whose content changed since being applied, as the new checksum baseline')
  .option('--allow-open-transactions', 'Run even if long-open transactions or metadata-lock waits are found on the database (runtime gate R2)');
addAllowOptions(upAllCommand)
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    
    let adapters;
    try {
      adapters = await getAdapters(options, { readOnly: Boolean(options.dryRun) });
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n🚀 Running migrations on ${adapters.length} instance(s)...\n`));
    
    let hasErrors = false;
    
    for (const { name, adapter } of adapters) {
      try {
        await adapter.connect();
        
        const status = await adapter.status();
        if (options.dryRun) {
          console.log(chalk.blue(`\n[${name}] ${resolveTargetLabel(adapter)} — would apply ${status.pending.length} migration(s)`));
          for (const p of status.pending) {
            console.log(chalk.gray(`   - ${p}`));
          }
          printChangelogConsistency(status);
          const gate = await enforceValidationGate(adapter, status, options, { report: true });
          await enforceRuntimeGates(adapter, options, { report: true, files: gate.files });
        } else {
          console.log(chalk.blue(`\n[${name}] ${resolveTargetLabel(adapter)} — running migrations...`));
          // Same pre-run gates as single-instance `up`
          enforceChangelogConsistencyGate(status);
          await enforceChecksumGate(status, adapter, options);
          const gate = await enforceValidationGate(adapter, status, options);
          if (status.pending.length > 0) await enforceRuntimeGates(adapter, options, { files: gate.files });
          const result = await adapter.up();
          
          if (result.applied.length > 0) {
            console.log(chalk.green(`   ✅ Applied ${result.applied.length} migration(s)`));
          } else if (result.errors.length === 0) {
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

      try {
        baseConfig.migrationsDir = resolveMigrationsDir(baseConfig, configPath, baseConfig.migrationsDir || 'migrations');
      } catch (error) {
        reporter.addResult({
          database: relativePath, dbType, testType: 'connection', success: false, duration: 0,
          error: `Invalid config: ${error.message}`
        });
        continue;
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

              // @expect-fail files are intentionally non-idempotent fixtures —
              // NOT IDEMPOTENT is the correct, expected outcome there, so flip
              // the reported pass/fail rather than treating it as a real failure.
              const expectFail = file.annotations?.expectFail === true;
              const reportSuccess = expectFail ? !idempotencyResult.success : idempotencyResult.success;

              if (idempotencyResult.success) {
                console.log(chalk.green(`      ✅ IDEMPOTENT`));
              } else if (expectFail) {
                console.log(chalk.green(`      ✅ NOT IDEMPOTENT (expected): ${idempotencyResult.error}`));
              } else {
                console.log(chalk.red(`      ❌ NOT IDEMPOTENT: ${idempotencyResult.error}`));
              }

              reporter.addResult({
                database: `${label} [${file.fileName}]`,
                dbType,
                testType: 'dcl-idempotency',
                success: reportSuccess,
                duration: Date.now() - fileStart,
                error: reportSuccess
                  ? null
                  : (idempotencyResult.success
                      ? 'Expected this migration to fail idempotency check, but it passed'
                      : idempotencyResult.error)
              });
            }

          } else {
            // ═══════════════════════════════════════════════════════
            // DDL: Validate + Up-Down-Up Test
            // ═══════════════════════════════════════════════════════

            // Run validation — judged per file against its @expect-error
            // annotation (see src/core/fixture-expectations.js): a file meant
            // to be rejected must fail with exactly the declared codes, every
            // other file must be valid.
            console.log(chalk.blue(`\n[VALIDATE] ${label} (${dbType})...`));
            const validateStart = Date.now();
            const validateResult = await adapter.validate();
            let expectsRejections = false;
            if (validateResult.error) {
              reporter.addResult({
                database: label, dbType, testType: 'validate', success: false,
                duration: Date.now() - validateStart, error: `Validation could not run: ${validateResult.error}`
              });
            }
            for (const r of validateResult.results) {
              const content = await fs.readFile(path.join(config.migrationsDir, r.file), 'utf-8');
              const expected = parseExpectedErrors(content);
              if (expected) expectsRejections = true;
              const outcome = checkFileExpectation(r, expected);
              const note = expected ? ` (expected: ${expected.join(', ')})` : '';
              console.log(outcome.ok ? chalk.green(`   ✅ ${r.file}${note}`) : chalk.red(`   ❌ ${r.file}: ${outcome.message}`));
              reporter.addResult({
                database: `${label} [${r.file}]`,
                dbType,
                testType: 'validate',
                success: outcome.ok,
                duration: Date.now() - validateStart,
                error: outcome.message
              });
            }

            // Up-Down-Up only for fixtures whose migrations are all meant to
            // be valid: ones meant to be rejected are never executed by
            // up/sync either (validation gate), so running them proves nothing.
            if (expectsRejections) {
              console.log(chalk.gray(`\n[TEST] ${label} — Up-Down-Up skipped: contains migrations that are expected to be rejected`));
            } else {
              console.log(chalk.blue(`\n[TEST] ${label} (${dbType}) Up-Down-Up...`));
              const testResult = await adapter.runUpDownUpTest();
              reporter.addResult({
                database: label,
                dbType,
                testType: 'up-down-up',
                success: testResult.success,
                duration: testResult.duration,
                error: testResult.success ? null : testResult.error
              });
            }

            // ═══════════════════════════════════════════════════════
            // DDL: Sanity Check (optional, requires --sanity-check flag)
            // ═══════════════════════════════════════════════════════
            // Skipped for directories of migrations meant to be rejected —
            // up/sync would never execute them.
            if (options.sanityCheck && !expectsRejections && typeof adapter.upWithSanityCheck === 'function') {
              console.log(chalk.blue(`\n[SANITY] ${label} (${dbType}) PreCheck/PostCheck...`));
              console.log(chalk.cyan(`   Sanity Check: ENABLED`));

              // Reset DB to clean state (down all), then re-run with sanity checks
              const statusAfterTest = await adapter.status();
              const appliedCount = statusAfterTest.applied.length;
              if (appliedCount > 0) {
                await adapter.down(appliedCount);
              }

              const supportsSchema = typeof adapter.getSchemaSnapshot === 'function';
              const schemaBefore = supportsSchema ? await adapter.getSchemaSnapshot() : null;
              const sanityStart = Date.now();
              const sanityRunResult = await adapter.upWithSanityCheck({ verbose: false });
              const { pending: pendingAfter } = await adapter.status();
              const schemaAfter = supportsSchema ? await adapter.getSchemaSnapshot() : null;

              // Per-migration results, judged against each file's
              // @expect-sanity annotation (see src/core/fixture-expectations.js)
              const results = sanityRunResult.sanityResults || [];
              for (const sr of results) {
                if (sr.skipped === true) {
                  console.log(chalk.gray(`   ⏭️  ${sr.file}: SKIPPED (no sanity blocks)`));
                  continue;
                }
                const content = await fs.readFile(path.join(config.migrationsDir, sr.file), 'utf-8');
                const expected = parseExpectedSanity(content);
                const outcome = checkSanityExpectation(sr, expected, { stillPending: pendingAfter.includes(sr.file) });

                // A rollback is only really proven if the database ended up
                // exactly as it started — checkable when it was the only
                // migration this run touched.
                if (outcome.ok && expected === 'rollback' && supportsSchema && results.length === 1) {
                  const diff = diffSchemaSnapshots(schemaBefore, schemaAfter);
                  if (!isDiffEmpty(diff)) {
                    outcome.ok = false;
                    outcome.message = 'rolled back, but the schema differs from before the run';
                  }
                }

                if (outcome.ok) {
                  console.log(chalk.green(expected === 'rollback'
                    ? `   ✅ ${sr.file}: Post-Check failed as expected and was rolled back — database restored (${sr.error})`
                    : `   ✅ ${sr.file}: PASSED`));
                } else {
                  console.log(chalk.red(`   ❌ ${sr.file}: ${outcome.message}`));
                }
                reporter.addResult({
                  database: `${label} [${sr.file}]`,
                  dbType,
                  testType: 'sanity-check',
                  success: outcome.ok,
                  duration: Date.now() - sanityStart,
                  error: outcome.message
                });
              }

              if (results.filter(sr => !sr.skipped).length === 0) {
                console.log(chalk.gray(`   (no sanity blocks in any migration)`));
              }
              for (const e of sanityRunResult.errors || []) {
                if (!results.some(sr => e.startsWith(`${sr.file}:`))) {
                  console.log(chalk.red(`   ❌ ${e}`));
                  reporter.addResult({ database: label, dbType, testType: 'sanity-check', success: false, duration: Date.now() - sanityStart, error: e });
                }
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
  .option('--approved-by <name>', 'Who approved the forbidden operations --validate lets through')
  .option('-o, --output <dir>', 'Directory to write the run notification email to', 'reports')
  .option('--plan', 'Show what a run would change — script diffs, affected accounts and their current grants, passwords to be generated — without executing')
  .option('--accept-removed-dcl', 'Forget applied DCL scripts that were deleted from disk (their accounts/grants are left as they are)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    let adapter;
    
    try {
      adapter = await getAdapter(options, { readOnly: Boolean(options.plan || options.dryRun) });
      await adapter.connect();
      
      const config = await loadConfig(options.config);
      const migrationsDir = resolveMigrationsDir(config, options.config);
      
      const runner = new RepeatableRunner({
        checksumTable: resolveChecksumTable(config)
      });
      
      // validator is only passed through when --validate is enabled
      const context = buildDCLContext(adapter, migrationsDir, {
        validator: options.validate ? adapter : null,
        approvedBy: options.approvedBy
      });

      if (options.plan) {
        printDCLPlan(await buildDCLPlan(runner, adapter, context), resolveTargetLabel(adapter));
        return;
      }

      if (options.dryRun) {
        const status = await runner.status(context);
        console.log(chalk.blue('\n[DRY RUN] Would apply these DCL migrations:'));
        for (const p of status.pending) {
          console.log(`   ${p.fileName} (${p.reason})${dirTag(p, Array.isArray(migrationsDir))}`);
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
      // R3 only: account changes don't wait on table locks, but must not go to a read-only node
      await enforceRuntimeGates(adapter, options, { locks: false, disk: false });
      await enforceRemovedDCLGate(runner, context, options);
      const beforeDCLState = await captureDCLState(dclChecker, adapter, config);

      const result = await runner.run(context);

      if (result.applied.length > 0) {
        console.log(chalk.green(`\n✅ Applied ${result.applied.length} DCL migration(s):`));
        for (const m of result.applied) {
          const annotationInfo = m.annotations?.allowDangerous ? chalk.yellow(' [allow-dangerous]') : '';
          console.log(`   ${m.fileName} (${m.reason})${dirTag(m, Array.isArray(migrationsDir))}${annotationInfo}`);
        }
      } else if ((!result.skipped || result.skipped.length === 0) && result.errors.length === 0) {
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

      printDCLApprovals(result.approvals);

      if (result.errors.length > 0) {
        console.error(chalk.red('\n❌ Errors:'));
        for (const e of result.errors) {
          console.error(`   ${e}`);
        }
        process.exitCode = 1;
      }

      // Diff + notification email run whenever anything was attempted — success
      // or failure (runner.run() stops on first error, so applied/errors can
      // both be non-empty: some migrations DID apply before the one that
      // failed). This is the only place a generated password appears (see
      // recordCredentialEvents() in repeatable-runner.js), so it must not be
      // skipped just because the run partially failed.
      if (result.applied.length > 0 || result.errors.length > 0) {
        const afterDCLState = await captureDCLState(dclChecker, adapter, config);
        const dclDiff = dclChecker.diffStates(beforeDCLState, afterDCLState, adapter.dbType);
        if (result.applied.length > 0) {
          console.log(chalk.blue(`\n[DCL] Account/permission changes (${adapter.dbType}):`));
          console.log(chalk.gray('─'.repeat(60)));
          printDCLDiff(dclDiff, adapter.dbType);
          console.log(chalk.gray('─'.repeat(60)));
        }

        const events = buildDCLNotificationEvents(runner.credentialEvents, dclDiff, adapter.dbType);
        const hasSkipped = result.skipped && result.skipped.length > 0;
        if (events.length > 0 || result.errors.length > 0 || hasSkipped) {
          const report = buildNotificationEmail({
            project: resolveProjectLabel(adapter, config),
            target: resolveTargetLabel(adapter),
            environment: process.env.DB_MIGRATE_ENVIRONMENT,
            dbType: adapter.dbType,
            status: result.errors.length > 0 ? 'failed' : 'success',
            dcl: {
              events,
              errors: result.errors.length > 0 ? result.errors : undefined,
              skipped: hasSkipped ? result.skipped : undefined
            },
            approvals: result.approvals
          });
          const saved = await saveNotificationEmail(options.output, notificationEmailToHTML(report), undefined, notificationOptions(config));
          console.log(chalk.gray(`\n   📧 Notification email written to ${saved.path} (latest copy: ${saved.latestPath})`));
          printNotificationCleanup(saved);
        }
      }
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exitCode = 1;
      // Best-effort — a failure before runner.run() ever started (bad config,
      // connect() failed) still deserves a notification; must never itself
      // throw and mask the real error.
      try {
        const report = buildNotificationEmail({
          project: adapter ? resolveProjectLabel(adapter, {}) : (options.config || 'unknown'),
          environment: process.env.DB_MIGRATE_ENVIRONMENT,
          dbType: adapter?.dbType || 'unknown',
          status: 'failed',
          dcl: { events: [], errors: [error.message] }
        });
        const saved = await saveNotificationEmail(options.output || 'reports', notificationEmailToHTML(report), undefined, notificationOptions(adapter?.config));
        console.log(chalk.gray(`   📧 Failure notification written to ${saved.path} (latest copy: ${saved.latestPath})`));
        printNotificationCleanup(saved);
      } catch (notifyError) {
        console.error(chalk.gray(`   (also failed to write failure notification: ${notifyError.message})`));
      }
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
      adapter = await getAdapter(options, { readOnly: true });
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
      const multiDir = Array.isArray(migrationsDir);
      for (const p of status.pending) {
        console.log(`   ${p.fileName}${dirTag(p, multiDir)}`);
        console.log(chalk.gray(`      Reason: ${p.reason}`));
      }
      
      console.log(chalk.green(`\n✅ Up-to-date (${status.upToDate.length}):`));
      for (const u of status.upToDate) {
        console.log(`   ${u.fileName}${dirTag(u, multiDir)}`);
        console.log(chalk.gray(`      Applied: ${u.appliedAt}`));
      }
      printOrphanedDCL(status.orphaned);
      
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
  .option('--approved-by <name>', 'Who approved the forbidden operations --validate lets through')
  .option('-o, --output <dir>', 'Directory for the per-instance notification emails and the run summary', 'reports')
  .option('--plan', 'Show what a run would change on each instance, without executing')
  .option('--accept-removed-dcl', 'Forget applied DCL scripts that were deleted from disk (their accounts/grants are left as they are)')
  .action(async (cmdOptions, cmd) => {
    const options = { ...cmd.parent.opts(), ...cmdOptions };
    
    let adapters;
    try {
      adapters = await getAdapters(options, { readOnly: Boolean(options.plan || options.dryRun) });
      assertUniqueInstanceNames(adapters);
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n🔐 Running DCL migrations on ${adapters.length} instance(s)...\n`));

    // One id for this run's files: notification-<instance>-<runId>.html …
    const runId = newRunId();
    let hasErrors = false;
    const dclChecker = new DCLIdempotentChecker({ verbose: false });
    const summaryInstances = [];

    for (const { name, adapter, config: instanceConfig } of adapters) {
      // Each instance runs its own migrationsDir (falls back to the top-level
      // one — see getAdapters()), so instances can manage different accounts.
      const migrationsDir = instanceConfig.migrationsDir;
      const target = resolveTargetLabel(adapter);
      const summary = { name, target, dbType: adapter.dbType, status: 'success', events: [], errors: [] };
      try {
        await adapter.connect();

        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(instanceConfig)
        });

        const context = buildDCLContext(adapter, migrationsDir, {
          validator: options.validate ? adapter : null,
          approvedBy: options.approvedBy
        });

        if (options.plan) {
          printDCLPlan(await buildDCLPlan(runner, adapter, context), `[${name}] ${target}`);
        } else if (options.dryRun) {
          const status = await runner.status(context);
          console.log(chalk.blue(`\n[${name}] ${target} — would apply ${status.pending.length} DCL migration(s) from ${describeDirs(migrationsDir)}`));
          for (const p of status.pending) {
            console.log(chalk.gray(`   - ${p.fileName} (${p.reason})`) + dirTag(p, Array.isArray(migrationsDir)));
          }
        } else {
          console.log(chalk.blue(`\n[${name}] ${target} — running DCL migrations from ${describeDirs(migrationsDir)}...`));
          await enforceRuntimeGates(adapter, options, { locks: false, disk: false });
          await enforceRemovedDCLGate(runner, context, options);
          const beforeDCLState = await captureDCLState(dclChecker, adapter, instanceConfig);
          const result = await runner.run(context);

          if (result.applied.length > 0) {
            console.log(chalk.green(`   ✅ Applied ${result.applied.length} DCL migration(s)`));
            for (const m of result.applied) {
              console.log(chalk.gray(`      - ${m.fileName} (${m.reason})`) + dirTag(m, Array.isArray(migrationsDir)));
            }
          } else if (result.errors.length === 0) {
            console.log(chalk.gray(`   All DCL migrations are up-to-date.`));
          }
          
          if (result.skipped && result.skipped.length > 0) {
            console.log(chalk.yellow(`   ⏭️  Skipped ${result.skipped.length} migration(s) due to validation`));
          }
          printDCLApprovals(result.approvals, '      ');
          
          if (result.errors.length > 0) {
            hasErrors = true;
            summary.status = 'failed';
            summary.errors = result.errors;
            console.log(chalk.red(`   ❌ Errors:`));
            for (const e of result.errors) {
              console.log(chalk.red(`      - ${e}`));
            }
          }

          // Same rule as single-instance `dcl`: a partially failed run still
          // gets its email — passwords for what DID apply exist nowhere else.
          if (result.applied.length > 0 || result.errors.length > 0) {
            const afterDCLState = await captureDCLState(dclChecker, adapter, instanceConfig);
            const dclDiff = dclChecker.diffStates(beforeDCLState, afterDCLState, adapter.dbType);
            summary.events = buildDCLNotificationEvents(runner.credentialEvents, dclDiff, adapter.dbType);
          }
          const hasSkipped = result.skipped && result.skipped.length > 0;
          if (summary.events.length > 0 || result.errors.length > 0 || hasSkipped) {
            const report = buildNotificationEmail({
              project: `${resolveProjectLabel(adapter, instanceConfig)} (${name})`,
              target,
              environment: process.env.DB_MIGRATE_ENVIRONMENT,
              dbType: adapter.dbType,
              status: summary.status,
              dcl: {
                events: summary.events,
                errors: result.errors.length > 0 ? result.errors : undefined,
                skipped: hasSkipped ? result.skipped : undefined
              },
              approvals: result.approvals
            });
            const saved = await saveNotificationEmail(options.output, notificationEmailToHTML(report), instanceNotificationFileName(name), notificationOptions(instanceConfig, { runId }));
            summary.notificationFile = saved.path;
            console.log(chalk.gray(`      📧 Notification email written to ${saved.path}`));
            printNotificationCleanup(saved);
          }
        }
        
      } catch (error) {
        hasErrors = true;
        summary.status = 'failed';
        summary.errors = [error.message];
        console.log(chalk.red(`\n[${name}] ❌ Error: ${error.message}`));
      } finally {
        await adapter.disconnect();
      }
      summaryInstances.push(summary);
    }

    if (!options.dryRun && !options.plan) {
      try {
        const summaryReport = buildMultiInstanceSummary({
          project: path.basename(path.dirname(path.resolve(options.config))),
          environment: process.env.DB_MIGRATE_ENVIRONMENT,
          instances: summaryInstances
        });
        const saved = await saveNotificationEmail(options.output, multiInstanceSummaryToHTML(summaryReport), 'notification-summary.html', notificationOptions(adapters[0]?.config, { runId }));
        console.log(chalk.gray(`\n📋 Run summary (no passwords) written to ${saved.path} (latest copies: notification-summary.html, notification-<instance>.html)`));
        printNotificationCleanup(saved);
      } catch (summaryError) {
        hasErrors = true;
        console.error(chalk.red(`\n[ERROR] Failed to write run summary: ${summaryError.message}`));
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
      adapters = await getAdapters(options, { readOnly: true });
    } catch (error) {
      console.error(chalk.red(`[ERROR] ${error.message}`));
      process.exit(1);
    }
    
    console.log(chalk.blue(`\n📊 DCL Status for ${adapters.length} instance(s):\n`));
    console.log(chalk.gray('═'.repeat(60)));
    
    for (const { name, adapter, config: instanceConfig } of adapters) {
      try {
        await adapter.connect();
        
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(instanceConfig)
        });
        
        const context = buildDCLContext(adapter, instanceConfig.migrationsDir);
        
        const status = await runner.status(context);
        
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType}) ${resolveTargetLabel(adapter)}`));
        console.log(chalk.gray(`  ${describeDirs(instanceConfig.migrationsDir)}`));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(chalk.yellow(`  ⏳ Pending: ${status.pending.length}`));
        console.log(chalk.green(`  ✅ Up-to-date: ${status.upToDate.length}`));
        printOrphanedDCL(status.orphaned);
        
        if (status.pending.length > 0) {
          for (const p of status.pending) {
            console.log(chalk.gray(`     - ${p.fileName} (${p.reason})`) + dirTag(p, Array.isArray(instanceConfig.migrationsDir)));
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
    
    console.log(chalk.blue(`\n🔍 Verifying DCL idempotency on ${adapters.length} instance(s)...\n`));
    console.log(chalk.gray('═'.repeat(60)));
    
    let allPassed = true;
    
    for (const { name, adapter, config: instanceConfig } of adapters) {
      try {
        await adapter.connect();
        
        const migrationsDir = instanceConfig.migrationsDir;
        const runner = new RepeatableRunner({
          checksumTable: resolveChecksumTable(instanceConfig)
        });
        
        const checker = new DCLIdempotentChecker({
          verbose: instanceConfig.idempotencyCheck?.verbose ?? true
        });
        
        const context = buildDCLContext(adapter, migrationsDir);
        
        console.log(chalk.blue(`\n[${name}] (${adapter.dbType}) ${resolveTargetLabel(adapter)}`));
        console.log(chalk.gray('─'.repeat(40)));
        
        const files = await runner.getRepeatableFiles(migrationsDir);
        
        for (const file of files) {
          console.log(chalk.blue(`  📄 ${file.fileName}`));
          
          const executeScript = () => executeDCLFile(adapter, runner, file);
          
          const result = await checker.verify(context, executeScript, {
            database: adapter.config?.mariadb?.database || instanceConfig.database,
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
