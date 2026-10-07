/**
 * MariaDB sanity-block syntax check: each EXPECT_* directive is its own
 * statement (as executeSanityCheck() runs them). They used to be joined and
 * re-split on ';', so two directives without DATABASE() — which skips the
 * check — were parsed as one statement and falsely rejected.
 */

import { describe, it, expect } from 'vitest';
import { MariaDBAdapter } from '../src/adapters/mariadb-adapter.js';

const migration = (sanity) =>
  `-- +migrate Up\n-- +sanity PreCheck\n${sanity}\n-- -sanity PreCheck\nCREATE TABLE t2 (id INT);\n-- +migrate Down\nDROP TABLE t2;\n`;
const sanityErrors = (sanity) =>
  new MariaDBAdapter({ mariadb: {} }).validateContent(migration(sanity), 'x.sql', {}).errors.filter(e => e.code === 'SANITY_SQL_SYNTAX_ERROR');

describe('MariaDB sanity block syntax check', () => {
  it('accepts several EXPECT directives, each checked on its own', () => {
    expect(sanityErrors([
      '-- EXPECT_NO_ROWS: SELECT 1 FROM products WHERE price < 0 OR price IS NULL LIMIT 1',
      '-- EXPECT_NO_ROWS: SELECT 1 FROM products WHERE price > 99999999.99 LIMIT 1',
      '-- EXPECT_ROWS: SELECT 1 FROM products'
    ].join('\n'))).toEqual([]);
  });

  it('accepts directives mixed with raw SQL statements', () => {
    expect(sanityErrors('-- EXPECT_ROWS: SELECT 1 FROM a\nSELECT 1 FROM b;\nSELECT 1\n  FROM c;')).toEqual([]);
  });

  it('still reports a directive that really is invalid', () => {
    const errors = sanityErrors('-- EXPECT_ROWS: SELECT 1 FROM a\n-- EXPECT_ROWS: SELEC 1 FROM b');
    expect(errors).toHaveLength(1);
  });
});

describe('MariaDB syntax check — IF [NOT] EXISTS on index / column clauses', () => {
  const syntaxErrors = (up, down = 'DROP TABLE IF EXISTS zz;') =>
    new MariaDBAdapter({ mariadb: {} })
      .validateContent(`-- +migrate Up\n${up}\n-- +migrate Down\n${down}\n`, 'x.sql', {})
      .errors.filter(e => e.code === 'SQL_SYNTAX_ERROR' || e.code === 'SQL_SYNTAX_ERROR_DOWN');

  it('accepts the re-runnable forms MariaDB supports (they used to be refused as syntax errors)', () => {
    expect(syntaxErrors([
      'CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY, c INT);',
      'ALTER TABLE t ADD COLUMN IF NOT EXISTS d INT, ADD INDEX IF NOT EXISTS i_d (d);',
      'CREATE INDEX IF NOT EXISTS i_c ON t (c);',
      'ALTER TABLE t MODIFY COLUMN IF EXISTS d BIGINT;'
    ].join('\n'), [
      'ALTER TABLE t DROP INDEX IF EXISTS i_d, DROP COLUMN IF EXISTS d;',
      'DROP INDEX IF EXISTS i_c ON t;',
      'ALTER TABLE t DROP KEY IF EXISTS i_c;'
    ].join('\n'))).toEqual([]);
  });

  it('accepts ALTER TABLE … ADD UNIQUE in every form (the parser rejects all of them on its own)', () => {
    expect(syntaxErrors([
      'CREATE TABLE IF NOT EXISTS t (id INT PRIMARY KEY, a INT, b INT, c INT, d INT);',
      'ALTER TABLE t ADD UNIQUE u_a (a);',
      'ALTER TABLE t ADD UNIQUE KEY u_b (b), ADD UNIQUE INDEX IF NOT EXISTS u_c (c);',
      'ALTER TABLE t ADD UNIQUE IF NOT EXISTS u_d (d);',
      'ALTER TABLE t ADD CONSTRAINT uq_ab UNIQUE (a, b);',
      'ALTER TABLE t ADD CONSTRAINT `uq ac` UNIQUE KEY (a, c);'
    ].join('\n'))).toEqual([]);
    expect(syntaxErrors('ALTER TABLE t ADD UNIQUE KEY u_a (a;').map(e => e.code)).toEqual(['SQL_SYNTAX_ERROR']);
  });

  it('still reports a real syntax error in such a statement', () => {
    expect(syntaxErrors('ALTER TABLE t ADD INDEX IF NOT EXISTS i_d (d;').map(e => e.code)).toEqual(['SQL_SYNTAX_ERROR']);
    expect(syntaxErrors('CREATE TABLE t (id INT);', 'ALTER TABLE t DROP INDEX IF EXISTS i_d,, DROP COLUMN IF EXISTS d;').map(e => e.code)).toEqual(['SQL_SYNTAX_ERROR_DOWN']);
  });
});
