import { describe, expect, it } from 'vitest';

import { parseJsonFromModelText } from './generateObject';

describe('parseJsonFromModelText', () => {
  it('parses a raw JSON object', () => {
    expect(parseJsonFromModelText('{"title":"ok"}')).toEqual({ title: 'ok' });
  });

  it('strips a json code fence', () => {
    expect(parseJsonFromModelText('```json\n{"title":"ok"}\n```')).toEqual({ title: 'ok' });
  });

  it('strips a bare code fence', () => {
    expect(parseJsonFromModelText('```\n{"n":1}\n```')).toEqual({ n: 1 });
  });

  it('throws on empty or non-JSON text', () => {
    expect(() => parseJsonFromModelText('')).toThrow(SyntaxError);
    expect(() => parseJsonFromModelText('not json')).toThrow(SyntaxError);
  });
});
