/**
 * Checks a hand-written WHERE condition before it is embedded in a browse query.
 * It must stay a single expression: no `;` (a second statement) and no unbalanced `)` that could close
 * the wrapping parentheses early. Quotes, quoted identifiers, dollar-quoted bodies and comments are skipped.
 * Returns a user-facing problem, or null when the condition is acceptable.
 */
export function checkRawCondition(raw: string): string | null {
  if (!raw.trim()) return 'Enter a condition.';
  let depth = 0;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < raw.length) {
        if (raw[j] !== ch) j++;
        else if (raw[j + 1] === ch) j += 2;
        else break;
      }
      if (j >= raw.length) return 'A quote is not closed.';
      i = j + 1;
    } else if (ch === '-' && raw[i + 1] === '-') {
      const end = raw.indexOf('\n', i);
      i = end < 0 ? raw.length : end + 1;
    } else if (ch === '/' && raw[i + 1] === '*') {
      const end = raw.indexOf('*/', i + 2);
      if (end < 0) return 'A comment is not closed.';
      i = end + 2;
    } else if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(raw.slice(i, i + 64))?.[0];
      if (tag) {
        const end = raw.indexOf(tag, i + tag.length);
        if (end < 0) return 'A $-quoted string is not closed.';
        i = end + tag.length;
      } else {
        i++;
      }
    } else if (ch === ';') {
      return 'Use a single condition — remove the “;”.';
    } else {
      if (ch === '(') depth++;
      if (ch === ')' && --depth < 0) return 'Parentheses are unbalanced.';
      i++;
    }
  }
  return depth === 0 ? null : 'Parentheses are unbalanced.';
}
