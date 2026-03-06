/**
 * MariaDB Production Server - DCL Configuration
 *
 * DCL (Data Control Language) migrations use Repeatable mode:
 * - Files prefixed with R__ are re-executed when checksum changes
 * - Must be idempotent (same result on multiple executions)
 * - No down migration required
 *
 * Managed by: Platform Team
 */

export default {
  type: 'mariadb',
  mode: 'repeatable',
};
