import {
  decodeBase64Latin1,
  decodeBase64Utf8,
  encodeLatin1Base64,
  encodeUtf8Base64,
} from './binary';
import { TURNSTILE_LOCAL_STORAGE_KEYS } from './constants';
import {
  parseJsonPreservingNumbers,
  PyFloat,
  pyFloatToStr,
  pyJsonStringify,
  pyStr,
  unwrapPyFloat,
} from './pyJson';

/**
 * Port of the chatgpt.com turnstile "VM": the `dx` payload decodes to a list of
 * `[opcode, ...args]` instructions that the browser SDK interprets against a
 * numeric register file. No JS engine, no eval — a hand-written interpreter,
 * faithful to the reference implementation.
 *
 * The reference is Python, which distinguishes `int` from `float`; the program
 * is therefore decoded with {@link parseJsonPreservingNumbers}, which tags every
 * numeral Python would have read as a `float` (see `pyJson.ts`). Integers stay
 * plain JS numbers.
 */

/** Insertion-ordered map used by `window.Object.create` inside the program. */
class OrderedMap {
  readonly keys: string[] = [];
  readonly values = new Map<string, unknown>();

  add(key: string, value: unknown) {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }
}

const PSEUDO_GLOBAL_TO_STRING: Record<string, string> = {
  'window.Math': '[object Math]',
  'window.Math.random': 'function random() { [native code] }',
  'window.Object': 'function Object() { [native code] }',
  'window.Object.create': 'function create() { [native code] }',
  'window.Object.keys': 'function keys() { [native code] }',
  'window.Reflect': '[object Reflect]',
  'window.Reflect.set': 'function set() { [native code] }',
  'window.localStorage': '[object Storage]',
  'window.performance': '[object Performance]',
  'window.performance.now': 'function () { [native code] }',
};

/**
 * The reference's `_turnstile_to_str`. The tail is Python's `str()`, which for a
 * container is `[1, 1.0]` / `{'k': 1.0}` and not JS's `1,1` / `[object Object]` —
 * hence {@link pyStr} rather than `String()`.
 */
const toStr = (value: unknown): string => {
  if (value === null || value === undefined) return 'undefined';
  if (value instanceof PyFloat) return pyFloatToStr(value.value);
  if (typeof value === 'string') return PSEUDO_GLOBAL_TO_STRING[value] ?? value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.join(',');
  return pyStr(value);
};

/**
 * Python's `isinstance(x, (str, float))` — integers are deliberately excluded,
 * which is what steers opcode 5 into its `"NaN"` branch.
 */
const isStrOrFloat = (value: unknown): boolean =>
  typeof value === 'string' || value instanceof PyFloat;

export const xorString = (text: string, key: string): string => {
  if (!key) return text;
  let out = '';
  for (let i = 0; i < text.length; i += 1)
    out += String.fromCodePoint(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  return out;
};

type Instruction = [number, ...unknown[]];

/**
 * @param dx base64 of the XOR-obfuscated instruction program (from `prepare`)
 * @param p  the legacy requirements token, used as the XOR key
 * @returns the turnstile token, or `undefined` when the program yields nothing
 */
export const solveTurnstileToken = (dx: string, p: string): string | undefined => {
  let program: Instruction[];
  try {
    // `atob` semantics: the browser SDK XORs the RAW bytes of the payload. A
    // UTF-8 decode would replace every invalid sequence with U+FFFD and destroy
    // the XOR input irreversibly.
    const parsed: unknown = parseJsonPreservingNumbers(xorString(decodeBase64Latin1(dx), p));
    if (!Array.isArray(parsed)) return undefined;
    program = parsed as Instruction[];
  } catch {
    return undefined;
  }

  const map = new Map<unknown, unknown>();
  const startedAt = Date.now();
  let result = '';

  // Python hashes `2.0` and `2` to the same dict key, so register indices are
  // compared by value, never by `PyFloat` identity.
  const read = (key: unknown): unknown => map.get(unwrapPyFloat(key));
  const write = (key: unknown, value: unknown) => {
    map.set(unwrapPyFloat(key), value);
  };

  const handlers: Record<number, (...args: any[]) => void> = {
    1: (e: number, t: number) => {
      write(e, xorString(toStr(read(e)), toStr(read(t))));
    },
    2: (e: number, t: unknown) => {
      write(e, t);
    },
    3: (e: string) => {
      // the reference implementation calls `.encode()` here (UTF-8, unlike the
      // Latin-1 `dx` decode), which throws for anything that is not a string —
      // keep both behaviours
      if (typeof e !== 'string') throw new TypeError('opcode 3 expects a string');
      result = encodeUtf8Base64(e);
    },
    5: (e: number, t: number) => {
      const current = read(e);
      const incoming = read(t);
      if (Array.isArray(current)) {
        write(e, [...current, incoming]);
        return;
      }
      if (isStrOrFloat(current) || isStrOrFloat(incoming)) {
        write(e, toStr(current) + toStr(incoming));
        return;
      }
      write(e, 'NaN');
    },
    6: (e: number, t: number, n: number) => {
      const tv = read(t);
      const nv = read(n);
      if (typeof tv !== 'string' || typeof nv !== 'string') return;
      const value = `${tv}.${nv}`;
      write(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value);
    },
    7: (e: number, ...args: number[]) => {
      const target = read(e);
      const values = args.map((arg) => read(arg));
      if (target === 'window.Reflect.set') {
        const [obj, key, value] = values;
        if (obj instanceof OrderedMap) obj.add(pyStr(key), value);
        return;
      }
      if (typeof target === 'function') (target as (...a: unknown[]) => void)(...values);
    },
    8: (e: number, t: number) => {
      write(e, read(t));
    },
    14: (e: number, t: number) => {
      write(e, parseJsonPreservingNumbers(String(read(t))));
    },
    15: (e: number, t: number) => {
      write(e, pyJsonStringify(read(t)));
    },
    17: (e: number, t: number, ...args: number[]) => {
      const callArgs = args.map((arg) => read(arg));
      const target = read(t);
      switch (target) {
        case 'window.performance.now': {
          write(e, new PyFloat(Date.now() - startedAt + Math.random()));
          return;
        }
        case 'window.Object.create': {
          write(e, new OrderedMap());
          return;
        }
        case 'window.Object.keys': {
          if (callArgs[0] === 'window.localStorage') write(e, [...TURNSTILE_LOCAL_STORAGE_KEYS]);
          return;
        }
        case 'window.Math.random': {
          write(e, new PyFloat(Math.random()));
          return;
        }
        default: {
          if (typeof target === 'function')
            write(e, (target as (...a: unknown[]) => unknown)(...callArgs));
        }
      }
    },
    18: (e: number) => {
      write(e, decodeBase64Utf8(toStr(read(e))));
    },
    19: (e: number) => {
      write(e, encodeUtf8Base64(toStr(read(e))));
    },
    20: (e: number, t: number, n: number, ...args: number[]) => {
      // `1 == 1.0` in Python, so compare the unwrapped values
      if (unwrapPyFloat(read(e)) !== unwrapPyFloat(read(t))) return;
      const target = read(n);
      if (typeof target === 'function')
        (target as (...a: unknown[]) => void)(...args.map((arg) => read(arg)));
    },
    21: () => {
      /* no-op */
    },
    23: (e: number, t: number, ...args: unknown[]) => {
      const target = read(t);
      // NOTE: opcode 23 forwards the RAW args, it does not resolve registers.
      if (read(e) !== null && read(e) !== undefined && typeof target === 'function')
        (target as (...a: unknown[]) => void)(...args);
    },
    24: (e: number, t: number, n: number) => {
      const tv = read(t);
      const nv = read(n);
      if (typeof tv === 'string' && typeof nv === 'string') write(e, `${tv}.${nv}`);
    },
  };

  for (const [opcode, handler] of Object.entries(handlers)) map.set(Number(opcode), handler);
  map.set(9, program);
  map.set(10, 'window');
  map.set(16, p);

  for (const instruction of program) {
    if (!Array.isArray(instruction)) continue;
    try {
      const handler = map.get(unwrapPyFloat(instruction[0]));
      if (typeof handler === 'function')
        (handler as (...a: unknown[]) => void)(...instruction.slice(1));
    } catch {
      // A single broken instruction must not abort the whole program — the
      // upstream SDK behaves the same way.
      continue;
    }
  }

  return result || undefined;
};

/**
 * Test/helper: encode an instruction program the way the upstream `dx` does —
 * XOR over the raw bytes, then base64, i.e. the inverse of the Latin-1 decode
 * above. `PyFloat` operands are written Python-style (`3.0`).
 */
export const encodeTurnstileProgram = (program: unknown[], p: string): string =>
  encodeLatin1Base64(xorString(pyJsonStringify(program) ?? '[]', p));
