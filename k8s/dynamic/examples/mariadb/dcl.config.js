// DCL config — same as ddl.config.js, but its own account (needs CREATE USER
// and GRANT OPTION) and repeatable mode.
import { readFileSync } from 'fs';

const cred = (key) => readFileSync(`/var/run/secrets/db-migrate/dcl/${key}`, 'utf8').trim();

export default {
  type: 'mariadb',
  mode: 'repeatable',
  host: process.env.MARIADB_HOST,
  port: Number(process.env.MARIADB_PORT || 3306),
  user: cred('username'),
  password: cred('password'),
  database: process.env.MARIADB_DATABASE,
  // RDS / any server with require_secure_transport=ON: put the CA bundle in the
  // profile directory (shipped as /app/config/<name>.pem) and uncomment:
  // ssl: { caFile: '/app/config/global-bundle.pem' },
  migrationsDir: '/app/migrations/dcl',
  checksumTable: '_dcl_migrations',
};
