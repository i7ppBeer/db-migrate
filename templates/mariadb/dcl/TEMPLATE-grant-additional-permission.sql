-- Rename to R__040_grant_analytics_insert.sql before use.
--
-- No CHANGE_ME_ON_FIRST_LOGIN here — this only changes grants on an account
-- that already exists. Shows up in the notification email as a
-- `permissions_updated` event with the before/after GRANT list, no password
-- involved.

GRANT INSERT ON myapp.analytics TO 'app_analytics'@'%';

FLUSH PRIVILEGES;
