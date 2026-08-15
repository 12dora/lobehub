import { describe, expect, it } from 'vitest';

import {
  parseJsonPreservingNumbers,
  PyFloat,
  pyFloatToStr,
  pyJsonStringify,
  pyRepr,
  pyStr,
} from './pyJson';

describe('pyFloatToStr', () => {
  it('formats floats the way Python repr does', () => {
    // reference values: python3 -c "print(repr(x))"
    expect(pyFloatToStr(3)).toBe('3.0');
    expect(pyFloatToStr(2.5)).toBe('2.5');
    expect(pyFloatToStr(1000)).toBe('1000.0');
    expect(pyFloatToStr(0.1)).toBe('0.1');
    expect(pyFloatToStr(0.000_1)).toBe('0.0001');
    expect(pyFloatToStr(-2.5)).toBe('-2.5');
    expect(pyFloatToStr(0)).toBe('0.0');
    expect(pyFloatToStr(-0)).toBe('-0.0');
    expect(pyFloatToStr(1 / 3)).toBe('0.3333333333333333');
  });

  it('switches to the exponent form on Python thresholds, not the JS ones', () => {
    // JS `String()` would say '0.00001' / '10000000000000000' / '1e-7'
    expect(pyFloatToStr(0.000_01)).toBe('1e-05');
    expect(pyFloatToStr(1e15)).toBe('1000000000000000.0');
    expect(pyFloatToStr(1e16)).toBe('1e+16');
    expect(pyFloatToStr(1.5e16)).toBe('1.5e+16');
    expect(pyFloatToStr(1e21)).toBe('1e+21');
    expect(pyFloatToStr(1e-7)).toBe('1e-07');
    expect(pyFloatToStr(5e-324)).toBe('5e-324');
    expect(pyFloatToStr(1.797_693_134_862_315_7e308)).toBe('1.7976931348623157e+308');
  });

  it('formats the IEEE specials as Python str() does', () => {
    expect(pyFloatToStr(Number.NaN)).toBe('nan');
    expect(pyFloatToStr(Infinity)).toBe('inf');
    expect(pyFloatToStr(-Infinity)).toBe('-inf');
  });
});

describe('parseJsonPreservingNumbers', () => {
  it('keeps integer literals as plain numbers', () => {
    expect(parseJsonPreservingNumbers('1')).toBe(1);
    expect(parseJsonPreservingNumbers('-42')).toBe(-42);
    expect(parseJsonPreservingNumbers('0')).toBe(0);
  });

  it('tags every literal Python would decode as a float', () => {
    for (const [text, value] of [
      ['1.0', 1],
      ['2.5', 2.5],
      ['1e3', 1000],
      ['1E3', 1000],
      ['-1.5e-3', -0.001_5],
      ['1e0', 1],
    ] as const) {
      const parsed = parseJsonPreservingNumbers(text);
      expect(parsed, text).toBeInstanceOf(PyFloat);
      expect((parsed as PyFloat).value, text).toBe(value);
    }
  });

  it('accepts the Python NaN / Infinity extensions', () => {
    expect((parseJsonPreservingNumbers('NaN') as PyFloat).value).toBeNaN();
    expect((parseJsonPreservingNumbers('Infinity') as PyFloat).value).toBe(Infinity);
    expect((parseJsonPreservingNumbers('[-Infinity]') as PyFloat[])[0].value).toBe(-Infinity);
  });

  it('matches JSON.parse on documents without floats', () => {
    const documents = [
      '{"a":[1,2,{"b":"c"}],"d":null,"e":true,"f":false}',
      '[]',
      '{}',
      '"\\u00e9\\n\\t\\\\ \\" /"',
      '  [ 1 , 2 ]  ',
      '{"dup":1,"dup":2}',
      '[[2,1,"x"],[3,"golden"]]',
    ];
    for (const document of documents)
      expect(parseJsonPreservingNumbers(document), document).toEqual(JSON.parse(document));
  });

  it('preserves floats inside nested containers', () => {
    const parsed = parseJsonPreservingNumbers('{"a": [1, 1.0], "b": {"c": 1e3}}') as {
      a: unknown[];
      b: { c: PyFloat };
    };
    expect(parsed.a[0]).toBe(1);
    expect(parsed.a[1]).toBeInstanceOf(PyFloat);
    expect(parsed.b.c.value).toBe(1000);
  });

  it('treats "__proto__" as an ordinary own key, exactly like JSON.parse', () => {
    const text = '{"__proto__": {"polluted": true}, "a": 1}';
    const parsed = parseJsonPreservingNumbers(text) as Record<string, unknown>;

    // an own, enumerable, serialisable data property — not a prototype swap
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.keys(parsed)).toEqual(['__proto__', 'a']);
    expect(parsed['__proto__']).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(JSON.parse(text)));

    // and nothing leaked onto Object.prototype or onto unrelated objects
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '{', '[1,]', '1 2', '"unterminated', 'undefined', '{a:1}', '01', '.5'])
      expect(() => parseJsonPreservingNumbers(bad), bad).toThrow(SyntaxError);
  });
});

describe('pyJsonStringify', () => {
  it('serialises floats the way json.dumps does', () => {
    expect(pyJsonStringify(new PyFloat(3))).toBe('3.0');
    expect(pyJsonStringify([1, new PyFloat(1), new PyFloat(2.5)])).toBe('[1,1.0,2.5]');
    expect(pyJsonStringify({ a: { b: new PyFloat(1000) } })).toBe('{"a":{"b":1000.0}}');
    expect(pyJsonStringify([new PyFloat(Number.NaN), new PyFloat(Infinity)])).toBe(
      '[NaN,Infinity]',
    );
  });

  it('is byte-identical to JSON.stringify without floats', () => {
    const values = [
      { a: [1, 2, { b: 'c' }], d: null },
      'plain "quoted" é \n',
      [1, undefined, () => 1],
      undefined,
      42,
    ];
    for (const value of values) expect(pyJsonStringify(value)).toEqual(JSON.stringify(value));
  });

  it('does not confuse payload strings with the internal float marker', () => {
    const value = ['__pyfloat_x__9.9', new PyFloat(1)];
    expect(pyJsonStringify(value)).toBe('["__pyfloat_x__9.9",1.0]');
  });
});

// expectations taken from CPython: `str(x)` / `repr(x)` on the same value
describe('pyStr / pyRepr', () => {
  it('spells scalars the Python way', () => {
    expect(pyStr('plain')).toBe('plain');
    expect(pyStr(1)).toBe('1');
    expect(pyStr(new PyFloat(1))).toBe('1.0');
    expect(pyStr(true)).toBe('True');
    expect(pyStr(false)).toBe('False');
    expect(pyStr(null)).toBe('None');
  });

  it('formats containers with repr-ed items and Python spacing', () => {
    expect(pyStr([1, new PyFloat(1)])).toBe('[1, 1.0]');
    expect(pyStr(['a', 1, null, true])).toBe("['a', 1, None, True]");
    expect(pyStr([])).toBe('[]');
    expect(pyStr({ k: new PyFloat(1), j: 2 })).toBe("{'k': 1.0, 'j': 2}");
    expect(pyStr({ a: { b: [new PyFloat(1)] }, c: null })).toBe("{'a': {'b': [1.0]}, 'c': None}");
    expect(pyStr({})).toBe('{}');
  });

  it('quotes strings the way repr does, and only there', () => {
    expect(pyRepr('a')).toBe("'a'");
    // a `'` in the text flips the quoting to `"` — unless a `"` is there too
    expect(pyRepr("it's")).toBe(`"it's"`);
    expect(pyRepr(`it's "q"`)).toBe(`'it\\'s "q"'`);
    expect(pyRepr('back\\slash\ttab\nnl')).toBe(String.raw`'back\\slash\ttab\nnl'`);
    // printable non-ASCII survives; control characters become escapes
    expect(pyRepr('中文é\u0001\u007F\u{1D400}')).toBe(String.raw`'中文é\x01\x7f𝐀'`);
    // repr === str for everything that is not a string
    expect(pyRepr(new PyFloat(2.5))).toBe('2.5');
    expect(pyRepr([1])).toBe('[1]');
  });
});
