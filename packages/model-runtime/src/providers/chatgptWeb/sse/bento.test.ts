import { describe, expect, it } from 'vitest';

import { inspectBentoText, isBentoOnlyText, stripBentoLayout } from './bento';

const AMBIGUOUS = ['{', '{"', '{"lay', '{"layout"', '{"layout":', '{"layout":"', '{"layout":"ben'];

describe('inspectBentoText', () => {
  it.each(AMBIGUOUS)('withholds the ambiguous prefix %j while streaming', (prefix) => {
    expect(inspectBentoText(prefix, { streaming: true })).toEqual({
      confirmed: false,
      ignored: false,
      text: prefix,
      withhold: true,
    });
  });

  it.each(AMBIGUOUS)('releases the ambiguous prefix %j once not streaming', (prefix) => {
    expect(inspectBentoText(prefix)).toEqual({
      confirmed: false,
      ignored: false,
      text: prefix,
      withhold: false,
    });
  });

  it('withholds a confirmed incomplete bento prefix', () => {
    expect(inspectBentoText('{"layout":"bento"')).toEqual({
      confirmed: true,
      ignored: true,
      text: '',
      withhold: true,
    });
  });

  it('withholds a complete bento object with no remainder', () => {
    expect(inspectBentoText('{"layout":"bento","query":["XX","XX","XX"]}')).toEqual({
      confirmed: true,
      ignored: true,
      text: '',
      withhold: true,
    });
  });

  it('drops a complete bento object and the following whitespace/newline', () => {
    expect(inspectBentoText('{"layout":"bento","query":["a"]}\n\nVisible answer')).toEqual({
      confirmed: true,
      ignored: false,
      text: 'Visible answer',
      withhold: false,
    });
  });

  it('drops a complete bento object glued to following prose', () => {
    expect(inspectBentoText('{"layout":"bento","query":["a"]}Visible answer')).toEqual({
      confirmed: true,
      ignored: false,
      text: 'Visible answer',
      withhold: false,
    });
  });

  it('allows JSON whitespace around layout:bento', () => {
    expect(inspectBentoText('{ "layout" : "bento" }')).toEqual({
      confirmed: true,
      ignored: true,
      text: '',
      withhold: true,
    });
  });

  it.each(['Hello', '{"name":"ok"}', '{"layout":"grid"}', '{"na', ' {"name":1}'])(
    'does not strip non-bento %j',
    (text) => {
      expect(inspectBentoText(text)).toEqual({
        confirmed: false,
        ignored: false,
        text,
        withhold: false,
      });
    },
  );
});

describe('isBentoOnlyText', () => {
  it('is true for a complete or confirmed-prefix bento object', () => {
    expect(isBentoOnlyText('{"layout":"bento","query":["XX"]}')).toBe(true);
    expect(isBentoOnlyText('{"layout":"bento"')).toBe(true);
  });

  it('is false for ambiguous prefixes and ordinary text', () => {
    expect(isBentoOnlyText('{')).toBe(false);
    expect(isBentoOnlyText('{"lay')).toBe(false);
    expect(isBentoOnlyText('{"layout":"bento","query":["a"]}Visible')).toBe(false);
    expect(isBentoOnlyText('Hello')).toBe(false);
  });
});

describe('stripBentoLayout', () => {
  it('clears a finished poll that is only the bento object', () => {
    expect(stripBentoLayout('{"layout":"bento","query":["XX"]}')).toBe('');
  });

  it('clears a confirmed incomplete bento prefix so a poll cannot reintroduce it', () => {
    expect(stripBentoLayout('{"layout":"bento"')).toBe('');
  });

  it('preserves an ambiguous JSON prefix during recovery', () => {
    expect(stripBentoLayout('{')).toBe('{');
    expect(stripBentoLayout('{"lay')).toBe('{"lay');
    expect(stripBentoLayout('{"layout":"ben')).toBe('{"layout":"ben');
  });

  it('keeps a real JSON answer', () => {
    expect(stripBentoLayout('{"name":"ok"}')).toBe('{"name":"ok"}');
  });
});
