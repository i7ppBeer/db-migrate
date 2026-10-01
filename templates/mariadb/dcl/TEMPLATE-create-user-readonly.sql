-- Rename to R__010_readonly_users.sql (R__<seq>_<name>.sql) before use, or:
--   node src/cli.js create-dcl readonly_users -n 010 -c <dcl-config>
--
-- CHANGE_ME_ON_FIRST_LOGIN is replaced at runtime with an independently
-- generated password — never written back to this file, never printed to
-- the console. It shows up exactly once, in plaintext, in the run's
-- notification email (reports/notification.html). It is NOT forced to
-- change unless the statement adds PASSWORD EXPIRE — do that for accounts a
-- person logs into, not for service accounts. See docs/DCL-PASSWORD.md.

CREATE USER IF NOT EXISTS 'app_readonly'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT ON myapp.* TO 'app_readonly'@'%';

FLUSH PRIVILEGES;
