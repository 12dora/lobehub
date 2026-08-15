import {
  decodeBase64Latin1,
  decodeBase64Utf8,
  encodeLatin1Base64,
  encodeUtf8Base64,
} from './binary';
import { TURNSTILE_LOCAL_STORAGE_KEYS } from './constants';

/**
 * Port of the chatgpt.com turnstile "VM": the `dx` payload decodes to a list of
 * `[opcode, ...args]` instructions that the browser SDK interprets against a
 * numeric register file. No JS engine, no eval — a hand-written interpreter,
 * faithful to the reference implementation.
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

const toStr = (value: unknown): string => {
  if (value === null || value === undefined) return 'undefined';
  if (typeof value === 'string') return PSEUDO_GLOBAL_TO_STRING[value] ?? value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.join(',');
  return String(value);
};

/**
 * Python's `isinstance(x, (str, float))` — integers are deliberately excluded,
 * which is what steers opcode 5 into its `"NaN"` branch.
 *
 * KNOWN DEVIATION (accepted): `JSON.parse` collapses `1` and `1.0` to the same
 * JS number, so an integral-valued float operand takes the `"NaN"` branch here
 * while Python concatenates it. Reproducing it would need a JSON parser that
 * preserves the lexical form of every number. Left as-is because every live
 * `chat-requirements/prepare` response we have seen reports
 * `turnstile.required === false`, so no program is executed at all; revisit if
 * turnstile is ever switched on for this client.
 */
const isStrOrFloat = (value: unknown): boolean =>
  typeof value === 'string' || (typeof value === 'number' && !Number.isInteger(value));

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
    const parsed: unknown = JSON.parse(xorString(decodeBase64Latin1(dx), p));
    if (!Array.isArray(parsed)) return undefined;
    program = parsed as Instruction[];
  } catch {
    return undefined;
  }

  const map = new Map<number, unknown>();
  const startedAt = Date.now();
  let result = '';

  const read = (key: unknown): unknown => map.get(key as number);

  const handlers: Record<number, (...args: any[]) => void> = {
    1: (e: number, t: number) => {
      map.set(e, xorString(toStr(read(e)), toStr(read(t))));
    },
    2: (e: number, t: unknown) => {
      map.set(e, t);
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
        map.set(e, [...current, incoming]);
        return;
      }
      if (isStrOrFloat(current) || isStrOrFloat(incoming)) {
        map.set(e, toStr(current) + toStr(incoming));
        return;
      }
      map.set(e, 'NaN');
    },
    6: (e: number, t: number, n: number) => {
      const tv = read(t);
      const nv = read(n);
      if (typeof tv !== 'string' || typeof nv !== 'string') return;
      const value = `${tv}.${nv}`;
      map.set(e, value === 'window.document.location' ? 'https://chatgpt.com/' : value);
    },
    7: (e: number, ...args: number[]) => {
      const target = read(e);
      const values = args.map((arg) => read(arg));
      if (target === 'window.Reflect.set') {
        const [obj, key, value] = values;
        if (obj instanceof OrderedMap) obj.add(String(key), value);
        return;
      }
      if (typeof target === 'function') (target as (...a: unknown[]) => void)(...values);
    },
    8: (e: number, t: number) => {
      map.set(e, read(t));
    },
    14: (e: number, t: number) => {
      map.set(e, JSON.parse(String(read(t))));
    },
    15: (e: number, t: number) => {
      map.set(e, JSON.stringify(read(t)));
    },
    17: (e: number, t: number, ...args: number[]) => {
      const callArgs = args.map((arg) => read(arg));
      const target = read(t);
      switch (target) {
        case 'window.performance.now': {
          map.set(e, Date.now() - startedAt + Math.random());
          return;
        }
        case 'window.Object.create': {
          map.set(e, new OrderedMap());
          return;
        }
        case 'window.Object.keys': {
          if (callArgs[0] === 'window.localStorage') map.set(e, [...TURNSTILE_LOCAL_STORAGE_KEYS]);
          return;
        }
        case 'window.Math.random': {
          map.set(e, Math.random());
          return;
        }
        default: {
          if (typeof target === 'function')
            map.set(e, (target as (...a: unknown[]) => unknown)(...callArgs));
        }
      }
    },
    18: (e: number) => {
      map.set(e, decodeBase64Utf8(toStr(read(e))));
    },
    19: (e: number) => {
      map.set(e, encodeUtf8Base64(toStr(read(e))));
    },
    20: (e: number, t: number, n: number, ...args: number[]) => {
      if (read(e) !== read(t)) return;
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
      if (typeof tv === 'string' && typeof nv === 'string') map.set(e, `${tv}.${nv}`);
    },
  };

  for (const [opcode, handler] of Object.entries(handlers)) map.set(Number(opcode), handler);
  map.set(9, program);
  map.set(10, 'window');
  map.set(16, p);

  for (const instruction of program) {
    if (!Array.isArray(instruction)) continue;
    try {
      const handler = map.get(instruction[0] as number);
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
 * above.
 */
export const encodeTurnstileProgram = (program: unknown[], p: string): string =>
  encodeLatin1Base64(xorString(JSON.stringify(program), p));
