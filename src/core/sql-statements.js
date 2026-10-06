/**
 * Split a MariaDB/MySQL script into the statements the server would run, so
 * a migration can be executed — and retried — one statement at a time.
 *
 * Understands what decides where a statement ends:
 *   - quoted text: '…' and "…" (backslash escapes, doubled quotes), `…`
 *   - comments: -- (followed by whitespace), #, and C-style comments
 *     (an executable comment stays in the statement text)
 *   - compound statements, whose bodies contain ';':
 *       CREATE [OR REPLACE] [DEFINER=…] PROCEDURE | FUNCTION | TRIGGER | EVENT …
 *       BEGIN NOT ATOMIC …, and top-level IF / CASE / LOOP / WHILE / REPEAT
 *     Blocks are tracked by depth: CASE always opens one; BEGIN, IF, LOOP,
 *     WHILE and REPEAT open one when they start a statement (after ';',
 *     THEN / ELSE / DO, a label, a routine header or HANDLER FOR …) — so the
 *     IF() / REPEAT() functions, IF [NOT] EXISTS and a column named `begin`
 *     don't; END closes one, and END IF / END LOOP / … consume their keyword.
 *     A word right after '.' or '@' (NEW.end, @end) is a name, never a keyword.
 *     A leading "label:" (lbl: BEGIN NOT ATOMIC …) is skipped.
 *
 * Returns null when it can't be sure — an unterminated quote or comment, or
 * a compound statement whose blocks don't balance — so the caller can send
 * the script as one batch instead of running a wrong split. Statements are
 * returned trimmed, without their ';'; comment-only ones are dropped.
 *
 * DELIMITER is a mysql-client command, not SQL — the server rejects it, and
 * so do migrations (see docs/USER-GUIDE-MARIADB.md, stored procedures).
 *
 * @param {string} sql
 * @returns {string[]|null}
 */
export function splitSqlStatements(sql) {
  if (!sql) return [];

  const BLOCK_KEYWORDS = ['IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT'];
  const ROUTINES = ['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'];
  // CREATE <one of these> is never a routine — stop looking for PROCEDURE etc.
  const OTHER_OBJECTS = new Set(['TABLE', 'VIEW', 'INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'USER', 'ROLE',
    'DATABASE', 'SCHEMA', 'SEQUENCE', 'SERVER', 'TABLESPACE', 'TEMPORARY', 'ALGORITHM', 'PACKAGE']);

  const statements = [];
  let start = 0;           // where the current statement begins
  let hasCode = false;     // it has something besides comments/whitespace
  let codeStart = -1;      // where its first non-comment text is (leading comments are dropped)
  let words = [];          // its leading words (upper-case), to recognize compound statements
  let compound = false;
  let depth = 0;           // open blocks in the compound statement
  let atBodyStatement = false; // next word starts a statement inside a block
  let afterEnd = false;    // previous word was END (END IF, END LOOP, …)
  let inHandler = false;   // after DECLARE … HANDLER, before its body
  let lastWord = '';       // previous word (upper-case)

  const markCode = (at) => {
    if (!hasCode) { hasCode = true; codeStart = at; }
  };
  const reset = (from) => {
    start = from; hasCode = false; codeStart = -1; words = []; compound = false;
    depth = 0; atBodyStatement = false; afterEnd = false; inHandler = false; lastWord = '';
  };
  const push = (end) => {
    if (!hasCode) return;
    const text = sql.slice(codeStart, end).trim();
    if (text) statements.push(text);
  };
  const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

  // lookahead right after a word, without copying the rest of the script
  const LABEL = /\s*:(?!=)/y;
  const at = (re, pos) => { re.lastIndex = pos; return re.exec(sql); };

  // Does a parenthesized group start at pos (after whitespace) with a comma at
  // its top level? That's a function call — IF(a, b, c), REPEAT('x', 3) — not
  // the IF (cond) THEN / REPEAT … statement.
  const isFunctionCall = (pos) => {
    let k = pos;
    while (/\s/.test(sql[k] ?? '')) k++;
    if (sql[k] !== '(') return false;
    let level = 0;
    for (; k < sql.length; k++) {
      const c = sql[k];
      if (c === "'" || c === '"' || c === '`') {
        for (k++; k < sql.length && sql[k] !== c; k++) if (sql[k] === '\\' && c !== '`') k++;
      } else if (c === '(') level++;
      else if (c === ')') { if (--level === 0) return false; }
      else if (c === ',' && level === 1) return true;
    }
    return false;
  };

  // Is the statement so far (words) a compound statement? true / false / null = can't tell yet
  const classify = () => {
    const [first, second, third] = words;
    if (first === 'CREATE') {
      // CREATE [OR REPLACE] [DEFINER = user@host | CURRENT_USER] [AGGREGATE] PROCEDURE …
      for (const w of words.slice(1)) {
        if (ROUTINES.includes(w)) return true;
        if (OTHER_OBJECTS.has(w)) return false;
      }
      return words.length < 8 ? null : false;
    }
    if (first === 'BEGIN') {
      if (second === undefined) return null;
      if (second !== 'NOT') return false;
      return third === undefined ? null : third === 'ATOMIC';
    }
    return BLOCK_KEYWORDS.includes(first);
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // ── comments ──
    if ((ch === '-' && next === '-' && (i + 2 >= sql.length || /\s/.test(sql[i + 2]))) || ch === '#') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return null;
      if (sql[i + 2] === '!') markCode(i); // executable comment
      i = close + 2;
      continue;
    }

    // ── quoted text ──
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === '\\' && ch !== '`') { j += 2; continue; }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      markCode(i);
      atBodyStatement = false;
      afterEnd = false;
      i = j + 1;
      continue;
    }

    // ── end of statement ──
    if (ch === ';') {
      if (!compound || depth === 0) {
        push(i);
        reset(i + 1);
      } else {
        atBodyStatement = true;
        afterEnd = false;
        inHandler = false;
      }
      i++;
      continue;
    }

    // ── words ──
    if (isWordChar(ch) && !isWordChar(sql[i - 1])) {
      let j = i;
      while (isWordChar(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      const prev = sql[i - 1];
      const before = lastWord;
      lastWord = word;
      markCode(i);
      i = j;

      if (!compound) {
        const label = words.length === 0 && at(LABEL, j);
        if (label) { // "lbl:" before a top-level block — classify what follows
          i = j + label[0].length;
          continue;
        }
        if (words.length < 8) {
          words.push(word);
          if (classify() === true) {
            compound = true;
            if (words[0] !== 'CREATE') {
              // a top-level block statement (or BEGIN NOT ATOMIC) is the first block
              depth = 1;
              atBodyStatement = words[0] === 'BEGIN' || word === 'LOOP' || word === 'REPEAT';
            }
          }
        }
        continue;
      }

      // inside a compound statement
      if (prev === '.' || prev === '@') { // NEW.end, t.begin, @end — a name
        atBodyStatement = false;
        afterEnd = false;
        continue;
      }
      if (afterEnd && BLOCK_KEYWORDS.includes(word)) { // END IF / END CASE / …
        afterEnd = false;
        continue;
      }
      afterEnd = false;

      const label = atBodyStatement && at(LABEL, j);
      if (label) { // "label:" before a block — the next word still starts a statement
        i = j + label[0].length;
        continue;
      }

      // A block keyword opens a block only where a statement can start: after
      // ';' / THEN / ELSE / DO / a label (atBodyStatement), after HANDLER FOR …,
      // or at depth 0 — the routine's header, or a body without BEGIN.
      // IF right after PROCEDURE/FUNCTION/… is the header's IF NOT EXISTS (in a
      // body, IF [NOT] EXISTS (SELECT …) THEN is a real IF), and IF(…, …) /
      // REPEAT(…, …) are functions.
      const startsStatement = atBodyStatement || inHandler || depth === 0;
      const opensBlock = startsStatement && (
        word === 'BEGIN' || word === 'LOOP' || word === 'WHILE' ||
        (word === 'IF' && !ROUTINES.includes(before) && !isFunctionCall(j)) ||
        (word === 'REPEAT' && !isFunctionCall(j)));

      if (word === 'END') {
        depth--;
        if (depth < 0) return null;
        afterEnd = true;
        atBodyStatement = false;
      } else if (word === 'CASE' || opensBlock) {
        depth++;
        if (word === 'BEGIN') inHandler = false;
        atBodyStatement = word === 'BEGIN' || word === 'LOOP' || word === 'REPEAT';
      } else {
        if (word === 'HANDLER') inHandler = true;
        atBodyStatement = ['THEN', 'ELSE', 'DO'].includes(word);
      }
      continue;
    }

    if (!/\s/.test(ch)) {
      markCode(i);
      atBodyStatement = false;
      afterEnd = false;
    }
    i++;
  }

  if (compound && depth !== 0) return null;
  push(sql.length);
  return statements;
}
