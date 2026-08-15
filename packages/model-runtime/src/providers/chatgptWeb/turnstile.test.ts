import { describe, expect, it } from 'vitest';

import {
  decodeBase64Latin1,
  decodeBase64Utf8,
  encodeLatin1Base64,
  encodeUtf8Base64,
} from './binary';
import { TURNSTILE_LOCAL_STORAGE_KEYS } from './constants';
import { encodeTurnstileProgram, solveTurnstileToken, xorString } from './turnstile';

const P = 'gAAAAACtest-key';

const run = (program: unknown[]) => solveTurnstileToken(encodeTurnstileProgram(program, P), P);

/**
 * Same wire format, but the program is handed over as RAW JSON text — the only
 * way to control whether a numeral reaches the VM as a Python `int` or `float`.
 */
const runJson = (json: string) => solveTurnstileToken(encodeLatin1Base64(xorString(json, P)), P);

describe('xorString', () => {
  it('round-trips with the same key', () => {
    expect(xorString(xorString('hello {"a":1}', P), P)).toBe('hello {"a":1}');
  });

  it('returns the input unchanged for an empty key', () => {
    expect(xorString('abc', '')).toBe('abc');
  });
});

describe('solveTurnstileToken', () => {
  it('returns undefined for a payload that is not a valid program', () => {
    expect(solveTurnstileToken('not-base64!!', P)).toBeUndefined();
    expect(solveTurnstileToken(encodeUtf8Base64('{"not":"an array"}'), '')).toBeUndefined();
  });

  it('returns undefined when the program never calls opcode 3', () => {
    expect(run([[2, 100, 'nothing']])).toBeUndefined();
  });

  it('opcode 3 base64-encodes its raw argument', () => {
    expect(run([[3, 'plain']])).toBe(encodeUtf8Base64('plain'));
  });

  it('opcode 5 concatenates strings and opcode 20 gates on equality', () => {
    const result = run([
      [2, 100, 'hello'],
      [2, 101, ' world'],
      [5, 100, 101],
      [2, 102, 'hello world'],
      [2, 103, 'concat-ok'],
      // map[100] === map[102] ⇒ call handler 3 with the RESOLVED register 103
      [20, 100, 102, 3, 103],
    ]);

    expect(result).toBe(encodeUtf8Base64('concat-ok'));
  });

  it('opcode 20 does not fire when the registers differ', () => {
    expect(
      run([
        [2, 100, 'a'],
        [2, 101, 'b'],
        [2, 102, 'never'],
        [20, 100, 101, 3, 102],
      ]),
    ).toBeUndefined();
  });

  it('opcodes 18/19 base64 round-trip a register', () => {
    const result = run([
      [2, 100, 'abc'],
      [19, 100], // -> 'YWJj'
      [18, 100], // -> 'abc'
      [2, 101, 'abc'],
      [2, 102, 'b64-roundtrip-ok'],
      [20, 100, 101, 3, 102],
    ]);

    expect(result).toBe(encodeUtf8Base64('b64-roundtrip-ok'));
  });

  it('opcodes 6 and 24 build dotted pseudo-globals', () => {
    const result = run([
      [2, 100, 'window'],
      [2, 101, 'Object'],
      [24, 102, 100, 101], // window.Object
      [2, 103, 'create'],
      [6, 104, 102, 103], // window.Object.create
      [2, 105, 'window.Object.create'],
      [2, 106, 'dotted-ok'],
      [20, 104, 105, 3, 106],
    ]);

    expect(result).toBe(encodeUtf8Base64('dotted-ok'));
  });

  it('opcode 6 rewrites window.document.location', () => {
    const result = run([
      [2, 100, 'window.document'],
      [2, 101, 'location'],
      [6, 102, 100, 101],
      [2, 103, 'https://chatgpt.com/'],
      [2, 104, 'location-ok'],
      [20, 102, 103, 3, 104],
    ]);

    expect(result).toBe(encodeUtf8Base64('location-ok'));
  });

  it('opcode 17 emulates Object.keys(localStorage) and Object.create', () => {
    const result = run([
      [2, 100, 'window.Object.keys'],
      [2, 101, 'window.localStorage'],
      [17, 102, 100, 101], // -> the hard-coded key list
      [15, 103, 102], // JSON.stringify
      [2, 104, JSON.stringify(TURNSTILE_LOCAL_STORAGE_KEYS)],
      [2, 105, 'localstorage-ok'],
      [20, 103, 104, 3, 105],
    ]);

    expect(result).toBe(encodeUtf8Base64('localstorage-ok'));
  });

  it('opcode 7 stores into a Reflect-created ordered map and opcode 23 passes raw args', () => {
    const result = run([
      [2, 100, 'window.Object.create'],
      [17, 101, 100], // ordered map
      [2, 102, 'window.Reflect.set'],
      [2, 103, 'key'],
      [2, 104, 'value'],
      [7, 102, 101, 103, 104],
      // opcode 23 forwards raw (unresolved) arguments to handler 3
      [23, 101, 3, 'final-token'],
    ]);

    expect(result).toBe(encodeUtf8Base64('final-token'));
  });

  it('decodes the dx payload as raw bytes, not UTF-8', () => {
    // XORing a plain ASCII program with a key whose bytes flip the high bit
    // produces a byte stream that is NOT valid UTF-8; a `TextDecoder` pass would
    // substitute U+FFFD and destroy the program.
    const key = 'ð©';
    const program = [[3, 'latin1-ok']];
    const dx = encodeTurnstileProgram(program, key);

    // the raw bytes really are invalid UTF-8 …
    expect(decodeBase64Utf8(dx)).toContain('�');
    // … yet the program still runs
    expect(solveTurnstileToken(dx, key)).toBe(encodeUtf8Base64('latin1-ok'));
  });

  it('golden: a fixed dx/p pair decodes to the reference program', () => {
    // produced by base64(xor(json, p)) over ASCII, i.e. what the upstream sends
    const p = 'gAAAAACabc';
    const dx = 'PBpzbXBtYRlAPksacm1jJiwNBgYJYxwc';

    expect(xorString(decodeBase64Latin1(dx), p)).toBe('[[2,1,"x"],[3,"golden"]]');
    expect(solveTurnstileToken(dx, p)).toBe(encodeUtf8Base64('golden'));
  });

  it('opcode 20 gates on Python equality, where 1 == 1.0', () => {
    expect(runJson('[[2,100,1],[2,101,1.0],[2,102,"eq-ok"],[20,100,101,3,102]]')).toBe(
      encodeUtf8Base64('eq-ok'),
    );
  });

  it('addresses a float register index like Python dict keys do (100.0 is 100)', () => {
    expect(runJson('[[2,100.0,"float-key-ok"],[20,100,100,3,100]]')).toBe(
      encodeUtf8Base64('float-key-ok'),
    );
  });

  it('skips broken instructions instead of aborting the program', () => {
    const result = run([
      [17, 999, 998], // unknown registers
      [5, 500, 501], // undefined registers
      [3, 'still-here'],
      ['not-a-number', 1],
    ]);

    expect(result).toBe(encodeUtf8Base64('still-here'));
  });
});

/**
 * `[20, r, r, 3, r]` compares a register with itself, so it always fires and
 * hands handler 3 the RESOLVED register — i.e. it prints register `r`.
 */
const readRegister = (setup: string) => {
  const token = runJson(`[${setup},[20,100,100,3,100]]`);
  return token === undefined ? undefined : decodeBase64Utf8(token);
};

const concat = (left: string, right: string) =>
  readRegister(`[2,100,${left}],[2,101,${right}],[5,100,101]`);

describe('solveTurnstileToken — Python int/float fidelity', () => {
  // expectations produced by the reference implementation's semantics:
  //   isinstance(x, (str, float)) and str(float) in utils/turnstile.py
  it('opcode 5 yields "NaN" for two ints', () => {
    expect(concat('1', '2')).toBe('NaN');
  });

  it('opcode 5 concatenates when either side is a float, including integral ones', () => {
    expect(concat('1.0', '1.0')).toBe('1.01.0');
    expect(concat('1.0', '2')).toBe('1.02');
    expect(concat('2', '1.0')).toBe('21.0');
    expect(concat('2.5', '3')).toBe('2.53');
    expect(concat('1e3', '"x"')).toBe('1000.0x');
    expect(concat('-1.5e-3', '"x"')).toBe('-0.0015x');
  });

  it('opcode 5 concatenates strings with ints, as Python does', () => {
    expect(concat('"a"', '7')).toBe('a7');
  });

  it('opcode 5 renders the IEEE specials with Python str()', () => {
    expect(concat('NaN', '"!"')).toBe('nan!');
    expect(concat('Infinity', '"!"')).toBe('inf!');
    expect(concat('-Infinity', '"!"')).toBe('-inf!');
  });

  it('opcode 5 appends to a list without stringifying it', () => {
    // register 100 holds a list ⇒ the float is pushed, and the later dump keeps
    // it a float
    expect(readRegister('[2,100,[1]],[2,101,1.0],[5,100,101],[15,100,100]')).toBe('[1,1.0]');
  });

  it('opcodes 14/15 round-trip floats through json.loads / json.dumps', () => {
    const payload = '{"a": [1, 1.0, 2.5], "b": {"c": 1e3}}';
    expect(readRegister(`[2,100,${JSON.stringify(payload)}],[14,101,100],[15,100,101]`)).toBe(
      '{"a":[1,1.0,2.5],"b":{"c":1000.0}}',
    );
  });

  it('opcode 19 base64-encodes a float-containing structure Python-style', () => {
    const payload = '[1, 1.0, 0.5]';
    const setup = `[2,100,${JSON.stringify(payload)}],[14,101,100],[15,100,101],[19,100]`;
    expect(readRegister(setup)).toBe(encodeUtf8Base64('[1,1.0,0.5]'));
    // and a bare float register: base64 of str(3.0), not of "3"
    expect(readRegister('[2,100,3.0],[19,100]')).toBe(encodeUtf8Base64('3.0'));
  });

  it('leaves float-free programs byte-identical (ints never stringify as 1.0)', () => {
    expect(readRegister('[2,100,[1,2]],[15,100,100]')).toBe('[1,2]');
    expect(readRegister('[2,100,1],[19,100]')).toBe(encodeUtf8Base64('1'));
  });
});

/**
 * `_turnstile_to_str` falls through to Python's `str()`, which renders a container
 * as `[1, 1.0]` / `{'k': 1.0}` (items via `repr`) and spells `True` / `False` /
 * `None` — JS `String()` would say `1,1`, `[object Object]`, `true`, `null`.
 *
 * Every expectation below was produced by running the same program through
 * `utils/turnstile.py` (the reference), and opcode 19 is fed the container
 * DIRECTLY — no opcode 15 in between, so `_turnstile_to_str` really sees a list or
 * a dict rather than an already-serialised string.
 */
describe('solveTurnstileToken — Python str() of composite values', () => {
  const toStrOf = (literal: string) => {
    const token = readRegister(`[2,100,${literal}],[19,100]`);
    return token === undefined ? undefined : decodeBase64Utf8(token);
  };

  it('renders lists with Python spacing and float repr', () => {
    expect(toStrOf('[1, 1.0]')).toBe('[1, 1.0]');
    expect(toStrOf('[0.5, 1e3, -2.5]')).toBe('[0.5, 1000.0, -2.5]');
    expect(toStrOf('[NaN, Infinity, -Infinity]')).toBe('[nan, inf, -inf]');
    expect(toStrOf('[[1, 1.0], {"k": 1.0}]')).toBe("[[1, 1.0], {'k': 1.0}]");
  });

  it('quotes strings inside containers with repr, and keeps bools / None Python-spelled', () => {
    expect(toStrOf('[1, "a", 1.0, true, false, null]')).toBe("[1, 'a', 1.0, True, False, None]");
    expect(toStrOf('["a", 1]')).toBe("['a', 1]");
    expect(toStrOf('true')).toBe('True');
    expect(toStrOf('false')).toBe('False');
  });

  it('renders dicts as Python does', () => {
    expect(toStrOf('{"k": 1.0, "j": 2}')).toBe("{'k': 1.0, 'j': 2}");
    expect(toStrOf('{"a": {"b": [1.0]}, "c": null}')).toBe("{'a': {'b': [1.0]}, 'c': None}");
    expect(toStrOf('{}')).toBe('{}');
  });

  it('follows Python repr quoting and escaping for keys and values', () => {
    expect(toStrOf('{"it\'s": "say \\"hi\\"", "tab\\t": "nl\\n"}')).toBe(
      `{"it's": 'say "hi"', 'tab\\t': 'nl\\n'}`,
    );
    // printable non-ASCII stays raw, control characters become \xNN
    expect(toStrOf('{"\\u4e2d\\u6587": "\\u00e9\\u0001"}')).toBe("{'中文': 'é\\x01'}");
  });

  it('keeps the all-strings shortcut ahead of str(), which joins on a comma', () => {
    expect(toStrOf('["a", "b"]')).toBe('a,b');
    expect(toStrOf('["a"]')).toBe('a');
    // `[]` satisfies `all(isinstance(item, str))` too ⇒ '' ⇒ no token at all
    expect(toStrOf('[]')).toBeUndefined();
  });

  it('routes opcode 5 concatenation through the same rendering', () => {
    expect(readRegister('[2,100,{"k": 1.0}],[2,101,"|x"],[5,100,101]')).toBe("{'k': 1.0}|x");
    expect(readRegister('[2,100,true],[2,101,"|x"],[5,100,101]')).toBe('True|x');
  });
});
