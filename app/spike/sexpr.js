// Port of Code/sexpr.py's parse_sexp — tokenizes and parses KiCad's s-expression file format.
const TERM_REGEX = /\s*(?:(\()|(\))|([+-]?\d+\.\d+(?=[\s)]))|(-?\d+(?=[\s)]))|"((?:[^"]|(?<=\\)")*)"|([^()\s]+))/g;

export function parseSexpr(text) {
  const tokens = [...text.matchAll(TERM_REGEX)];
  let i = 0;

  function parseOne() {
    const m = tokens[i];
    const [, lparen, rparen, floatNum, intNum, quoted, bare] = m;
    i++;
    if (lparen) {
      const list = [];
      while (i < tokens.length && !tokens[i][2]) {
        list.push(parseOne());
      }
      i++; // consume rparen
      return list;
    }
    if (rparen) throw new Error(`Unbalanced closing paren at token ${i}`);
    if (quoted !== undefined) return quoted.replace(/\\"/g, '"');
    if (floatNum) return parseFloat(floatNum);
    if (intNum) return parseInt(intNum, 10);
    return bare;
  }

  const result = parseOne();
  return result;
}

// Depth-first search for all sub-lists whose first element === key (mirrors kicad_mod.py's _getArray)
export function getArray(data, key, maxLevel = null, level = 0) {
  const result = [];
  if (maxLevel !== null && maxLevel <= level) return result;
  for (const item of data) {
    if (Array.isArray(item)) {
      result.push(...getArray(item, key, maxLevel, level + 1));
    } else if (item === key) {
      result.push(data);
    }
  }
  return result;
}

export function getValue(data, key, defValue = null, maxLevel = null) {
  const found = getArray(data, key, maxLevel);
  return found.length ? found[0][1] : defValue;
}
