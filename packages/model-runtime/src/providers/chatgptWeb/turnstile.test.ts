import { describe, expect, it } from 'vitest';

import { decodeBase64Latin1, decodeBase64Utf8, encodeUtf8Base64 } from './binary';
import { TURNSTILE_LOCAL_STORAGE_KEYS } from './constants';
import { encodeTurnstileProgram, solveTurnstileToken, xorString } from './turnstile';

const P = 'gAAAAACtest-key';

const run = (program: unknown[]) => solveTurnstileToken(encodeTurnstileProgram(program, P), P);

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
