import { describe, expect, it } from 'vitest';

import { inspectBentoText, stripBentoLayout } from './bento';

describe('inspectBentoText', () => {
  it.each(['{', '{"', '{"lay', '{"layout"', '{"layout":', '{"layout":"', '{"layout":"ben'])(
    'withholds the prefix %j',
    (prefix) => {
      expect(inspectBentoText(prefix)).toEqual({ ignored: false, text: '', withhold: true });
    },
  );

  it('withholds a complete bento object with no remainder', () => {
    expect(inspectBentoText('{"layout":"bento","query":["XX","XX","XX"]}')).toEqual({
      ignored: true,
      text: '',
      withhold: true,
    });
  });

  it('drops a complete bento object and the following whitespace/newline', () => {
    expect(inspectBentoText('{"layout":"bento","query":["a"]}\n\nVisible answer')).toEqual({
      ignored: false,
      text: 'Visible answer',
      withhold: false,
    });
  });

  it('drops a complete bento object glued to following prose', () => {
    expect(inspectBentoText('{"layout":"bento","query":["a"]}Visible answer')).toEqual({
      ignored: false,
      text: 'Visible answer',
      withhold: false,
    });
  });

  it('allows JSON whitespace around layout:bento', () => {
    expect(inspectBentoText('{ "layout" : "bento" }')).toEqual({
      ignored: true,
      text: '',
      withhold: true,
    });
  });

  it.each(['Hello', '{"name":"ok"}', '{"layout":"grid"}', '{"na', ' {"name":1}'])(
    'does not strip non-bento %j',
    (text) => {
      expect(inspectBentoText(text)).toEqual({ ignored: false, text, withhold: false });
    },
  );
});

describe('stripBentoLayout', () => {
  it('clears a finished poll that is only the bento object', () => {
    expect(stripBentoLayout('{"layout":"bento","query":["XX"]}')).toBe('');
  });

  it('clears an incomplete bento prefix so a poll cannot reintroduce it', () => {
    expect(stripBentoLayout('{"layout":"bento"')).toBe('');
  });

  it('keeps a real JSON answer', () => {
    expect(stripBentoLayout('{"name":"ok"}')).toBe('{"name":"ok"}');
  });
});
