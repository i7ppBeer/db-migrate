-- Rename to R__020_rotate_app_readonly_password.sql before use.
--
-- ALTER USER (not CREATE USER IF NOT EXISTS) always targets an existing
-- account, so this doesn't emit MariaDB's "account already exists" Note —
-- the runner records this as a `password_changed` event every time this
-- file's checksum changes, unconditionally, unlike CREATE USER which skips
-- the notification when the account was already there. Bump the sequence
-- number or edit this file to trigger a rotation; don't just re-run the
-- same content, since the checksum tracker will correctly skip it as a
-- no-op DCL script re-running is designed to avoid.
--
-- DROP USER / ALTER USER are high-risk operations by default — this needs
-- an explicit annotation to pass validation.
-- @allow-forbidden: true

ALTER USER 'app_readonly'@'%' IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

FLUSH PRIVILEGES;
