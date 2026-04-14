/**
 * DCL Scaffold
 * Automatically creates placeholder databases and tables so that
 * table-level GRANT statements in DCL migrations can execute without errors
 * when the target schema objects don't exist yet (e.g. in test environments
 * where only DCL, not DDL, is being tested).
 *
 * All DDL is executed with IF NOT EXISTS so the scaffold is fully idempotent.
 */

export class DCLScaffold {
  /**
   * Parse all GRANT...ON db.table TO targets from a SQL string.
   * Excludes global grants (*.*).
   * db.* grants return { db, table: null } (database-level, no table needed).
   *
   * @param {string} sql
   * @returns {{ db: string, table: string|null }[]}
   */
  parseGrantTargets(sql) {
    const results = [];
    const seen = new Set();

    // Match ON `db`.`table` or ON db.table (with optional backticks)
    const re = /\bON\s+`?(\w+)`?\.`?(\w+|\*)`?\s+TO\b/gi;
    let m;
    while ((m = re.exec(sql)) !== null) {
      const db = m[1];
      const tableRaw = m[2];

      // Exclude global grants (*.*) — db itself must not be *
      if (db === '*') continue;

      const table = tableRaw === '*' ? null : tableRaw;
      const key = `${db}.${table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ db, table });
    }

    return results;
  }

  /**
   * Create placeholder databases and tables (IF NOT EXISTS) for the given targets.
   *
   * @param {Object} connection   mysql2 connection (needs CREATE privilege)
   * @param {{ db: string, table: string|null }[]} targets
   * @param {Object} [options]
   * @param {boolean} [options.verbose=false]
   * @returns {Promise<{ databases: string[], tables: string[] }>}
   */
  async scaffold(connection, targets, options = {}) {
    const { verbose = false } = options;
    const databases = [];
    const tables = [];

    for (const { db, table } of targets) {
      // CREATE DATABASE
      const createDb = `CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`;
      if (verbose) {
        console.log(`   [scaffold] ${createDb}`);
      }
      await connection.execute(createDb);
      if (!databases.includes(db)) {
        databases.push(db);
      }

      // CREATE TABLE (only for table-level targets)
      if (table !== null) {
        const qualifiedName = `${db}.${table}`;
        const createTable = [
          `CREATE TABLE IF NOT EXISTS \`${db}\`.\`${table}\` (`,
          `  _scaffold_id INT AUTO_INCREMENT PRIMARY KEY,`,
          `  _note VARCHAR(64) DEFAULT 'dcl-scaffold placeholder'`,
          `) ENGINE=InnoDB`
        ].join('\n');
        if (verbose) {
          console.log(`   [scaffold] CREATE TABLE IF NOT EXISTS \`${db}\`.\`${table}\``);
        }
        await connection.execute(createTable);
        tables.push(qualifiedName);
      }
    }

    return { databases, tables };
  }

  /**
   * Parse all SQL contents and scaffold the required databases/tables.
   * Deduplicates targets across all provided SQL strings.
   *
   * @param {Object} connection
   * @param {string[]} sqlContents
   * @param {Object} [options]
   * @param {boolean} [options.verbose=false]
   * @returns {Promise<{ databases: string[], tables: string[] }>}
   */
  async scaffoldForDCL(connection, sqlContents, options = {}) {
    const seen = new Set();
    const targets = [];

    for (const sql of sqlContents) {
      for (const target of this.parseGrantTargets(sql)) {
        const key = `${target.db}.${target.table}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push(target);
        }
      }
    }

    if (targets.length === 0) {
      return { databases: [], tables: [] };
    }

    return this.scaffold(connection, targets, options);
  }
}
