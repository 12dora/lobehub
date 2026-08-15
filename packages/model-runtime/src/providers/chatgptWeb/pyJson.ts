/**
 * The turnstile "VM" is a port of a Python interpreter, and the Python program
 * it interprets distinguishes `int` from `float` — `isinstance(x, (str, float))`
 * decides whether opcode 5 concatenates or yields `"NaN"`, and `str(1.0)` is
 * `'1.0'`, not `'1'`.
 *
 * `JSON.parse` collapses that distinction: `1`, `1.0` and `1e0` all become the
 * JS number `1`. These helpers keep it: a numeral whose lexical form makes
 * Python's `json` produce a `float` (it contains `.`, `e` or `E`, or is one of
 * the `NaN` / `Infinity` extensions) is decoded as a tagged {@link PyFloat};
 * integer literals stay plain JS numbers, exactly like Python `int`.
 *
 * Isomorphic — no `node:*`.
 */

/** A number that Python's `json` module would have decoded as a `float`. */
export class PyFloat {
  constructor(readonly value: number) {}
}

export const isPyFloat = (value: unknown): value is PyFloat => value instanceof PyFloat;

/** `PyFloat` → its plain JS number; everything else untouched. */
export const unwrapPyFloat = (value: unknown): unknown =>
  value instanceof PyFloat ? value.value : value;

/**
 * Python's `repr(float)` / `str(float)`: shortest round-trip digits, always a
 * fractional part or an exponent, exponent form for `decpt <= -4 || decpt > 16`
 * with a sign and at least two exponent digits (`1e+16`, `1e-05`).
 *
 * `String(n)` in JS differs on all three counts (`10000000000000000`, `1`,
 * `1e-7`), so the digits are re-laid-out here.
 */
export const pyFloatToStr = (value: number): string => {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';

  const negative = value < 0 || Object.is(value, -0);
  const sign = negative ? '-' : '';
  const absolute = Math.abs(value);

  // `toExponential()` without an argument emits the shortest digit string that
  // uniquely identifies the double — the same digits Python's repr picks.
  const [mantissa, exponent] = absolute.toExponential().split('e');
  const digits = mantissa.replace('.', '');
  // position of the decimal point relative to the digit string, as CPython's
  // `format_float_short` calls it
  const decpt = Number(exponent) + 1;

  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1;
    const expSign = exp < 0 ? '-' : '+';
    return `${sign}${mantissa}e${expSign}${String(Math.abs(exp)).padStart(2, '0')}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  if (decpt >= digits.length) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
};

/** How `json.dumps` writes a float — `repr`, except for the IEEE specials. */
const pyJsonFloatToStr = (value: number): string => {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  return pyFloatToStr(value);
};

/** A value `parseJsonPreservingNumbers` would have produced for a JSON object. */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

// Everything Python's `repr` writes as an escape, plus the two quote characters.
const NON_PRINTABLE_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/**
 * Python's `repr()` of a `str`: single quotes, switching to double quotes when the
 * text contains a `'` but no `"`; backslash, the active quote and `\t` / `\n` / `\r`
 * are escaped, and every non-printable code point becomes `\xNN` / `\uNNNN` /
 * `\UNNNNNNNN` (printability = not in Cc/Cf/Cs/Co/Cn/Zl/Zp/Zs, with U+0020 printable).
 */
const pyReprStr = (text: string): string => {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    if (char === '\\') out += '\\\\';
    else if (char === quote) out += `\\${quote}`;
    else if (char === '\t') out += '\\t';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char !== ' ' && NON_PRINTABLE_RE.test(char)) {
      const code = char.codePointAt(0)!;
      if (code < 0x100) out += `\\x${code.toString(16).padStart(2, '0')}`;
      else if (code < 0x1_00_00) out += `\\u${code.toString(16).padStart(4, '0')}`;
      else out += `\\U${code.toString(16).padStart(8, '0')}`;
    } else out += char;
  }
  return out + quote;
};

/**
 * Python's `repr()`. Identical to {@link pyStr} for every type the VM can hold
 * except `str`, which is quoted — that is exactly what makes `str(['a'])` render
 * as `['a']` rather than `[a]`, since containers format their items with `repr`.
 */
export const pyRepr = (value: unknown): string =>
  typeof value === 'string' ? pyReprStr(value) : pyStr(value);

/**
 * Python's `str()` — unlike the VM's `_turnstile_to_str` it never remaps strings.
 *
 * Containers are rendered the way CPython does it (`[1, 1.0]`, `{'k': 1.0}`), with
 * `repr` applied to the items; `bool` and `None` keep their capitalised Python
 * spelling. `String()` would produce `1,1`, `[object Object]`, `true` and `null`.
 */
export const pyStr = (value: unknown): string => {
  if (value instanceof PyFloat) return pyFloatToStr(value.value);
  if (value === null) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map((item) => pyRepr(item)).join(', ')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .map((key) => `${pyReprStr(key)}: ${pyRepr(value[key])}`)
      .join(', ')}}`;
  return String(value);
};

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:E[+-]?\d+)?/iy;
const ESCAPES: Record<string, string> = {
  '"': '"',
  '/': '/',
  '\\': '\\',
  'b': '\b',
  'f': '\f',
  'n': '\n',
  'r': '\r',
  't': '\t',
};

/**
 * A JSON decoder with Python `json.loads` number semantics: integer literals
 * become JS numbers, anything Python would have turned into a `float` becomes a
 * {@link PyFloat}. Also accepts Python's `NaN` / `Infinity` / `-Infinity`
 * extensions. Throws `SyntaxError` on malformed input, like `JSON.parse`.
 */
export const parseJsonPreservingNumbers = (text: string): unknown => {
  let index = 0;

  const fail = (message: string): never => {
    throw new SyntaxError(`${message} at position ${index}`);
  };

  const skipWhitespace = () => {
    while (index < text.length) {
      const char = text[index];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break;
      index += 1;
    }
  };

  const expect = (literal: string) => {
    if (text.startsWith(literal, index)) index += literal.length;
    else fail(`expected ${literal}`);
  };

  const parseString = (): string => {
    index += 1; // opening quote
    let out = '';
    for (;;) {
      if (index >= text.length) fail('unterminated string');
      const char = text[index];
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === '\\') {
        const escape = text[index + 1];
        index += 2;
        if (escape === 'u') {
          const hex = text.slice(index, index + 4);
          if (!/^[\dA-F]{4}$/i.test(hex)) fail('invalid \\u escape');
          out += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
          continue;
        }
        const mapped = escape === undefined ? undefined : ESCAPES[escape];
        if (mapped === undefined) fail('invalid escape sequence');
        out += mapped;
        continue;
      }
      // JSON forbids raw control characters inside strings (Python's `strict`
      // decoder does too)
      if (char.charCodeAt(0) < 0x20) fail('unescaped control character in string');
      out += char;
      index += 1;
    }
  };

  const parseValue = (): unknown => {
    skipWhitespace();
    if (index >= text.length) fail('unexpected end of input');
    const char = text[index];

    switch (char) {
      case '"': {
        return parseString();
      }
      case '[': {
        index += 1;
        const items: unknown[] = [];
        skipWhitespace();
        if (text[index] === ']') {
          index += 1;
          return items;
        }
        for (;;) {
          items.push(parseValue());
          skipWhitespace();
          if (text[index] === ',') {
            index += 1;
            continue;
          }
          expect(']');
          return items;
        }
      }
      case '{': {
        index += 1;
        const object: Record<string, unknown> = {};
        skipWhitespace();
        if (text[index] === '}') {
          index += 1;
          return object;
        }
        for (;;) {
          skipWhitespace();
          if (text[index] !== '"') fail('expected an object key');
          const key = parseString();
          skipWhitespace();
          expect(':');
          // NOT `object[key] = …`: a `"__proto__"` key would hit the inherited
          // setter and mutate the prototype instead of creating a property.
          // `JSON.parse` defines an ordinary own property; so do we.
          Object.defineProperty(object, key, {
            configurable: true,
            enumerable: true,
            value: parseValue(),
            writable: true,
          });
          skipWhitespace();
          if (text[index] === ',') {
            index += 1;
            continue;
          }
          expect('}');
          return object;
        }
      }
      case 'f': {
        expect('false');
        return false;
      }
      case 'n': {
        expect('null');
        return null;
      }
      case 't': {
        expect('true');
        return true;
      }
      case 'N': {
        expect('NaN');
        return new PyFloat(Number.NaN);
      }
      case 'I': {
        expect('Infinity');
        return new PyFloat(Infinity);
      }
      default: {
        if (text.startsWith('-Infinity', index)) {
          index += 9;
          return new PyFloat(-Infinity);
        }
        NUMBER_RE.lastIndex = index;
        const match = NUMBER_RE.exec(text);
        if (!match) return fail('unexpected token');
        index += match[0].length;
        // Python's decoder splits on the lexical form, not on the value: a
        // numeral with a fraction or an exponent is a `float`, `1` is an `int`.
        return /[.E]/i.test(match[0]) ? new PyFloat(Number(match[0])) : Number(match[0]);
      }
    }
  };

  const value = parseValue();
  skipWhitespace();
  if (index !== text.length) fail('unexpected trailing data');
  return value;
};

/**
 * `JSON.stringify`, except that {@link PyFloat} values are written the way
 * `json.dumps` writes a float (`3.0`, `NaN`, `Infinity`). Everything else —
 * escaping, `undefined` handling, key order, the `undefined` return for a
 * non-serialisable root — is delegated to `JSON.stringify` so float-free values
 * serialise byte-for-byte as before.
 *
 * The floats travel through the replacer as an unguessable marker string and are
 * unquoted afterwards; a random marker makes a collision with real payload data
 * impossible.
 */
export const pyJsonStringify = (value: unknown): string | undefined => {
  const marker = `__pyfloat_${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}__`;

  const json = JSON.stringify(value, (_key, item: unknown) =>
    item instanceof PyFloat ? marker + pyJsonFloatToStr(item.value) : item,
  );
  if (json === undefined || !json.includes(marker)) return json;

  return json.replaceAll(
    new RegExp(`"${marker}([^"]*)"`, 'g'),
    (_match, literal: string) => literal,
  );
};
