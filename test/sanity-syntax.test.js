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
