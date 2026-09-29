-- Rename to R__030_remove_legacy_reporting_user.sql before use.
--
-- Shows up in the run's notification email as a `removed` event — the tool
-- detects this from a before/after account-state diff, not by parsing this
-- SQL for DROP USER, so it works the same way even if you REVOKE everything
-- and leave the account in place instead (that shows up as
-- `permissions_updated` rather than `removed`). See docs/E2E-SCENARIOS.md.
--
-- DROP USER is irreversible — needs explicit approval.
-- @allow-forbidden: true

DROP USER IF EXISTS 'legacy_reporting_svc'@'%';

FLUSH PRIVILEGES;
