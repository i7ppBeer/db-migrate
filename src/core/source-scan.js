/**
 * Small, quote-aware scanners for migration source (SQL and JS) — the kind
 * of text processing a regex gets wrong as soon as a comment contains an
 * apostrophe or a function body contains a nested `{ … }`.
 */

/**
 * Replace every comment character with a space (newlines kept), leaving
 * code and string literals untouched — so the result has the same length
 * and the same offsets as the input. Quote-aware: '--' or '//' inside a
 * string literal is not a comment, and an apostrophe inside a comment
 * doesn't start a string.
 *
 *   sql: -- … (followed by whitespace/EOL), # …, /* … *\/
 *   js:  // …, /* … *\/
 *
 * @param {string} content
 * @param {'sql'|'js'} lang
 * @returns {string}
 */
export function maskComments(content, lang) {
  if (!content) return content || '';
  const out = content.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];
    const next = content[i + 1];

    if (c === "'" || c === '"' || c === '`') {
      i = skipString(content, i);
      continue;
    }

    const lineComment =
      (lang === 'js' && c === '/' && next === '/') ||
      (lang === 'sql' && c === '-' && next === '-' && (i + 2 >= n || /\s/.test(content[i + 2]))) ||
      (lang === 'sql' && c === '#');
    if (lineComment) {
      const end = content.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (c === '/' && next === '*') {
      const end = content.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    i++;
  }
  return out.join('');
}

/** Index just past the string literal that starts at `start` (a quote char). */
function skipString(content, start) {
  const quote = content[start];
  let i = start + 1;
  while (i < content.length && content[i] !== quote) {
    if (content[i] === '\\') i++;
    i++;
  }
  return i + 1;
}

/**
 * Given the index of an opening `{` in JS source, return the index of its
 * matching `}` (or -1). Strings, template literals and comments are skipped,
 * so braces inside them don't count.
 */
export function findMatchingBrace(js, openIndex) {
  const code = maskComments(js, 'js');
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(code, i) - 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
