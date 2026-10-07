// DDL config — runs inside the Job. The URL (no credentials) comes from env
// (db.env); username/password from the mounted Secret files are inserted into
// it here. String insertion rather than new URL(), so multi-host and
// mongodb+srv:// URLs work too.
import { readFileSync } from 'fs';

const cred = (key) => readFileSync(`/var/run/secrets/db-migrate/ddl/${key}`, 'utf8').trim();
const url = process.env.MONGODB_URL.replace(
  '://',
  `://${encodeURIComponent(cred('username'))}:${encodeURIComponent(cred('password'))}@`
);

export default {
  type: 'mongodb',
  changelogCollection: 'changelog',
  mongodb: { url, databaseName: process.env.MONGODB_DATABASE },
  migrationsDir: '/app/migrations/ddl',
};
