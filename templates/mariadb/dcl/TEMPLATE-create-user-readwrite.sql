-- Rename to R__011_readwrite_users.sql before use.

CREATE USER IF NOT EXISTS 'app_readwrite'@'%'
  IDENTIFIED BY 'CHANGE_ME_ON_FIRST_LOGIN';

GRANT SELECT, INSERT, UPDATE, DELETE ON myapp.* TO 'app_readwrite'@'%';

FLUSH PRIVILEGES;
