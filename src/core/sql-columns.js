/**
 * Add a column to one of the tool's own bookkeeping tables if it isn't there
 * yet — the self-heal for tables created by older versions (changelog
 * `checksum`, DCL checksum table `content`).
 *
 * Not `ALTER TABLE … ADD COLUMN IF NOT EXISTS`: that's a MariaDB extension,
 * and MySQL rejects it with a syntax error. Checking information_schema
 * first works on both; a concurrent run adding the same column in between is
 * tolerated (ER_DUP_FIELDNAME).
 *
 * @param {Object} connection - mysql2 connection
 * @param {Object} spec
 * @param {string} spec.table - table name, as used in SQL (may be `db`.table)
 * @param {string} spec.tableName - bare table name, for the information_schema lookup
 * @param {string|null} [spec.schema] - database name; defaults to the connection's current one
 * @param {string} spec.column
 * @param {string} spec.definition - e.g. 'VARCHAR(64) NULL'
 * @returns {Promise<boolean>} true if the column was added
 */
export async function addColumnIfMissing(connection, { table, tableName, schema = null, column, definition }) {
  const [rows] = await connection.execute(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [schema, tableName, column]
  );
  if (rows.length > 0) return false;
  try {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
  } catch (error) {
    if (error.code === 'ER_DUP_FIELDNAME') return false;
    throw error;
  }
}
