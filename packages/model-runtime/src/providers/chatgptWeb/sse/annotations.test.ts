import { describe, expect, it } from 'vitest';

import { sanitizeAnnotations } from './annotations';

const START = '\uE200';
const END = '\uE201';
const SEP = '\uE202';

describe('sanitizeAnnotations', () => {
  it.each([
    ['empty input', '', ''],
    ['plain text', 'nothing to strip', 'nothing to strip'],
    [
      'url annotations become "label (url)"',
      `Repo: ${START}url${SEP}basketikun/chatgpt2api${SEP}https://github.com/basketikun/chatgpt2api${END} details ${START}cite${SEP}turn0search0${END}.`,
      'Repo: basketikun/chatgpt2api (https://github.com/basketikun/chatgpt2api) details.',
    ],
    [
      'entity annotations keep their label',
      `The character is from ${START}entity${SEP}Invincible${END}, a comic.`,
      'The character is from Invincible, a comic.',
    ],
    [
      'cite annotations keep the first readable part',
      `The character is ${START}cite${SEP}Invincible${SEP}turn0search0${END}.`,
      'The character is Invincible.',
    ],
    [
      'internal-only cites are removed together with the leading space',
      `details ${START}cite${SEP}turn0search0${END}.`,
      'details.',
    ],
    [
      'url annotations without a usable url fall back to the label',
      `see ${START}url${SEP}My Label${SEP}ftp://nope${END} here`,
      'see My Label here',
    ],
    [
      'an unterminated marker is dropped (streaming safety)',
      `partial answer ${START}cite${SEP}turn0sea`,
      'partial answer ',
    ],
    ['a space before punctuation in prose is preserved', 'find .', 'find .'],
    [
      'multiple annotations in one string',
      `${START}cite${SEP}turn0search0${END}a ${START}url${SEP}L${SEP}https://x.dev${END} b`,
      'a L (https://x.dev) b',
    ],
  ])('%s', (_name, input, expected) => {
    expect(sanitizeAnnotations(input)).toBe(expected);
  });

  it('tolerates nullish input', () => {
    expect(sanitizeAnnotations(undefined)).toBe('');
    expect(sanitizeAnnotations(null)).toBe('');
  });

  describe('streaming mode', () => {
    it('also withholds the whitespace an incoming marker may swallow', () => {
      // the terminated form collapses to "see." — emitting "see " now would make
      // the next delta non-additive
      expect(sanitizeAnnotations(`see ${START}cite${SEP}turn0sea`, { streaming: true })).toBe(
        'see',
      );
      expect(sanitizeAnnotations('see ', { streaming: true })).toBe('see');
      expect(sanitizeAnnotations(`see ${START}cite${SEP}turn0search0${END}.`)).toBe('see.');
    });

    it('leaves a completed text untouched', () => {
      expect(sanitizeAnnotations('done.', { streaming: true })).toBe('done.');
      expect(sanitizeAnnotations('trailing space ')).toBe('trailing space ');
    });
  });
});
