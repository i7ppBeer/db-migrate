import { describe, it, expect } from 'vitest';
import { splitSqlStatements } from '../src/core/sql-statements.js';

describe('splitSqlStatements', () => {
  it('splits plain statements and drops comment-only ones', () => {
    expect(splitSqlStatements(`
      -- a comment; with a semicolon
      CREATE TABLE a (id INT);   # trailing comment;
      /* block; comment */
      ALTER TABLE a ADD COLUMN b INT;
      INSERT INTO a VALUES (1)
    `)).toEqual(['CREATE TABLE a (id INT)', 'ALTER TABLE a ADD COLUMN b INT', 'INSERT INTO a VALUES (1)']);
  });

  it('ignores ; and comment markers inside quotes, backticks and escapes', () => {
    const sql = [
      `INSERT INTO t VALUES ('a;b', 'it''s; fine', 'back\\'slash; too', "dq; -- not a comment");`,
      'CREATE TABLE `odd;name` (`c;1` INT);',
      "SELECT '#not a comment', '/* nor this */';"
    ].join('\n');
    expect(splitSqlStatements(sql)).toEqual([
      `INSERT INTO t VALUES ('a;b', 'it''s; fine', 'back\\'slash; too', "dq; -- not a comment")`,
      'CREATE TABLE `odd;name` (`c;1` INT)',
      "SELECT '#not a comment', '/* nor this */'"
    ]);
  });

  it('"--" without a following space is not a comment (MariaDB rule)', () => {
    expect(splitSqlStatements('SELECT 1--1; SELECT 2')).toEqual(['SELECT 1--1', 'SELECT 2']);
  });

  it('keeps executable comments as SQL', () => {
    expect(splitSqlStatements('/*!40101 SET NAMES utf8mb4 */; SELECT 1;'))
      .toEqual(['/*!40101 SET NAMES utf8mb4 */', 'SELECT 1']);
  });

  it('keeps a stored procedure with nested blocks, labels, handlers and CASE as one statement', () => {
    const proc = `CREATE OR REPLACE DEFINER=root@localhost PROCEDURE p(IN n INT)
BEGIN
  DECLARE i INT DEFAULT 0;
  DECLARE done INT DEFAULT 0;
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN SET done = 1; END;
  lbl: LOOP
    SET i = i + 1;
    IF i > n THEN LEAVE lbl; ELSEIF i = 2 THEN SET done = IF(done, 0, 1); ELSE ITERATE lbl; END IF;
  END LOOP lbl;
  WHILE i > 0 DO SET i = i - 1; END WHILE;
  REPEAT SET i = i + 1; UNTIL i >= 3 END REPEAT;
  CASE i WHEN 3 THEN SELECT 'three;'; ELSE BEGIN END; END CASE;
  SELECT CASE WHEN i > 1 THEN 'x' ELSE 'y' END AS v;
  DROP TABLE IF EXISTS tmp;
END`;
    expect(splitSqlStatements(`${proc};\nSELECT 1;`)).toEqual([proc, 'SELECT 1']);
  });

  it('handles functions, triggers and events', () => {
    const fn = 'CREATE FUNCTION f(x INT) RETURNS INT DETERMINISTIC BEGIN IF x > 0 THEN RETURN 1; END IF; RETURN 0; END';
    const fnNoBody = 'CREATE FUNCTION g() RETURNS INT RETURN 7';
    const trg = 'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN SET NEW.b = 1; END';
    const trgNoBody = 'CREATE TRIGGER t2 BEFORE UPDATE ON a FOR EACH ROW SET NEW.b = 2';
    const ev = 'CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO BEGIN DELETE FROM a WHERE b = 0; END';
    expect(splitSqlStatements([fn, fnNoBody, trg, trgNoBody, ev, 'SELECT 1'].join(';\n')))
      .toEqual([fn, fnNoBody, trg, trgNoBody, ev, 'SELECT 1']);
  });

  it('a routine whose body is a bare IF (no BEGIN) is one statement; IF NOT EXISTS in the header is not a block', () => {
    const p = 'CREATE PROCEDURE IF NOT EXISTS p2(x INT) IF x > 0 THEN SELECT 1; ELSE SELECT 2; END IF';
    expect(splitSqlStatements(`${p}; SELECT 3`)).toEqual([p, 'SELECT 3']);
  });

  it('top-level compound statements: BEGIN NOT ATOMIC and IF', () => {
    const b = 'BEGIN NOT ATOMIC DECLARE x INT DEFAULT 1; SELECT x; END';
    const i = "IF (SELECT COUNT(*) FROM a) = 0 THEN INSERT INTO a VALUES (1); END IF";
    expect(splitSqlStatements(`${b};\n${i};\nSELECT 2`)).toEqual([b, i, 'SELECT 2']);
  });

  it('a top-level BEGIN (transaction) is an ordinary statement', () => {
    expect(splitSqlStatements('BEGIN; INSERT INTO a VALUES (1); COMMIT;'))
      .toEqual(['BEGIN', 'INSERT INTO a VALUES (1)', 'COMMIT']);
  });

  it('CASE / IF() in ordinary statements and object names like function_log are not compound', () => {
    expect(splitSqlStatements(
      "CREATE TABLE function_log (procedure_name VARCHAR(10)); UPDATE a SET b = CASE WHEN b IS NULL THEN 0 ELSE b END; SELECT IF(1, 'a', 'b');"
    )).toEqual([
      'CREATE TABLE function_log (procedure_name VARCHAR(10))',
      'UPDATE a SET b = CASE WHEN b IS NULL THEN 0 ELSE b END',
      "SELECT IF(1, 'a', 'b')"
    ]);
  });

  it('returns null when it cannot be sure', () => {
    expect(splitSqlStatements("SELECT 'unterminated")).toBeNull();
    expect(splitSqlStatements('SELECT 1 /* unterminated')).toBeNull();
    expect(splitSqlStatements('CREATE PROCEDURE p() BEGIN SELECT 1;')).toBeNull(); // missing END
    // body-less function returning IF(...) — IF at depth 0 followed by "(" is the function
    expect(splitSqlStatements('CREATE FUNCTION h() RETURNS INT RETURN IF(1, 2, 3); SELECT 1'))
      .toEqual(['CREATE FUNCTION h() RETURNS INT RETURN IF(1, 2, 3)', 'SELECT 1']);
  });

  it('empty / comment-only input → no statements', () => {
    expect(splitSqlStatements('')).toEqual([]);
    expect(splitSqlStatements('-- nothing\n/* here */')).toEqual([]);
  });
});
