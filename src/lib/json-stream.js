// Streaming helpers for Huawei export files.
//
// Huawei export files are top-level JSON arrays that can reach hundreds of MB,
// and the motion-path files are not even valid JSON (bare numeric keys such as
// `{1.0:868.0}` inside `partTimeMap`). JsonArrayStream splits a text stream into
// the source text of each top-level array element without building the whole
// document, so each element can be parsed (leniently) on its own.

const QUOTE = 34; // "
const BACKSLASH = 92; // \
const OPEN_BRACE = 123; // {
const CLOSE_BRACE = 125; // }
const OPEN_BRACKET = 91; // [
const CLOSE_BRACKET = 93; // ]
const COMMA = 44;

function isSpace(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff;
}

/**
 * Feed text chunks with push(); onItem(text) receives the source text of every
 * top-level array element. If the document is a single object instead of an
 * array, that object is emitted once. Strings and escapes may span chunks.
 */
export class JsonArrayStream {
  constructor(onItem) {
    this.onItem = onItem;
    this.mode = 'start'; // start | array | single | done
    this.depth = 0; // nesting depth inside the current element
    this.inString = false;
    this.escape = false;
    this.partial = ''; // text of the current element carried across chunks
    this.inElement = false;
    this.primitive = false; // current element is a bare number/literal
    this.count = 0;
  }

  push(text) {
    let i = 0;
    const n = text.length;
    let elStart = this.inElement ? 0 : -1;

    while (i < n) {
      if (this.mode === 'done') return;

      if (this.mode === 'start') {
        const c = text.charCodeAt(i);
        if (isSpace(c)) { i++; continue; }
        if (c === OPEN_BRACKET) { this.mode = 'array'; i++; continue; }
        if (c === OPEN_BRACE) {
          this.mode = 'single';
          this.inElement = true;
          elStart = i;
          this.depth = 1;
          i++;
          continue;
        }
        throw new Error('Not a JSON array or object');
      }

      if (!this.inElement) {
        // Between elements of the top-level array.
        const c = text.charCodeAt(i);
        if (isSpace(c) || c === COMMA) { i++; continue; }
        if (c === CLOSE_BRACKET) { this.mode = 'done'; return; }
        this.inElement = true;
        elStart = i;
        if (c === OPEN_BRACE || c === OPEN_BRACKET) {
          this.depth = 1;
          this.primitive = false;
          i++;
        } else if (c === QUOTE) {
          this.depth = 0;
          this.primitive = false;
          this.inString = true;
          i++;
        } else {
          this.depth = 0;
          this.primitive = true;
        }
        continue;
      }

      if (this.inString) {
        // Fast path: jump to the next quote or backslash.
        if (this.escape) { this.escape = false; i++; continue; }
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === QUOTE || c === BACKSLASH) break;
          j++;
        }
        if (j >= n) { i = n; break; }
        if (text.charCodeAt(j) === BACKSLASH) {
          this.escape = true;
          i = j + 1;
          continue;
        }
        this.inString = false;
        i = j + 1;
        if (this.depth === 0 && !this.primitive) {
          // A bare string as a top-level element.
          this.finishElement(text, elStart, i);
          elStart = -1;
        }
        continue;
      }

      const c = text.charCodeAt(i);
      if (this.primitive) {
        if (c === COMMA || c === CLOSE_BRACKET || isSpace(c)) {
          this.finishElement(text, elStart, i);
          elStart = -1;
          if (c === CLOSE_BRACKET) { this.mode = 'done'; return; }
          i++;
          continue;
        }
        i++;
        continue;
      }
      if (c === QUOTE) { this.inString = true; i++; continue; }
      if (c === OPEN_BRACE || c === OPEN_BRACKET) { this.depth++; i++; continue; }
      if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
        this.depth--;
        i++;
        if (this.depth === 0) {
          this.finishElement(text, elStart, i);
          elStart = -1;
          if (this.mode === 'single') { this.mode = 'done'; return; }
        }
        continue;
      }
      i++;
    }

    if (this.inElement && elStart >= 0) this.partial += text.slice(elStart);
  }

  finishElement(text, start, end) {
    const src = this.partial + text.slice(start, end);
    this.partial = '';
    this.inElement = false;
    this.primitive = false;
    this.count++;
    this.onItem(src);
  }

  end() {
    if (this.inElement && this.primitive && this.partial) {
      const src = this.partial;
      this.partial = '';
      this.inElement = false;
      this.count++;
      this.onItem(src);
    }
  }
}

/**
 * Quote bare numeric object keys outside string literals:
 * `{1.0:868.0,2.0:1730}` becomes `{"1.0":868.0,"2.0":1730}`.
 */
export function quoteBareKeys(text) {
  let out = '';
  let last = 0;
  let inString = false;
  let escape = false;
  let expectKey = false; // just saw `{` or `,` outside a string
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escape) escape = false;
      else if (c === BACKSLASH) escape = true;
      else if (c === QUOTE) inString = false;
      continue;
    }
    if (c === QUOTE) { inString = true; expectKey = false; continue; }
    if (c === OPEN_BRACE || c === COMMA) { expectKey = true; continue; }
    if (isSpace(c)) continue;
    if (expectKey && (c === 45 || (c >= 48 && c <= 57))) {
      // Possible bare numeric key: read the number, then require a colon.
      let j = i + 1;
      while (j < n) {
        const d = text.charCodeAt(j);
        if ((d >= 48 && d <= 57) || d === 46 || d === 101 || d === 69 || d === 43 || d === 45) j++;
        else break;
      }
      let k = j;
      while (k < n && isSpace(text.charCodeAt(k))) k++;
      if (k < n && text.charCodeAt(k) === 58) {
        out += text.slice(last, i) + '"' + text.slice(i, j) + '"';
        last = j;
      }
      i = j - 1;
    }
    expectKey = false;
  }
  return last === 0 ? text : out + text.slice(last);
}

/** JSON.parse, retrying once with bare numeric keys quoted. */
export function parseLenient(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    const fixed = quoteBareKeys(text);
    if (fixed === text) throw err;
    return JSON.parse(fixed);
  }
}

/**
 * Parse every element of a JSON array held in `text` (a whole file).
 * Elements that fail to parse are counted, not thrown.
 */
export function parseArrayText(text, onValue) {
  let errors = 0;
  const stream = new JsonArrayStream((src) => {
    let value;
    try {
      value = parseLenient(src);
    } catch {
      errors++;
      return;
    }
    onValue(value);
  });
  stream.push(text);
  stream.end();
  return { count: stream.count, errors };
}
