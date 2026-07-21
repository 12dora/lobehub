import { describe, expect, it } from 'vitest';

import {
  buildKvUpdateValues,
  marketPrefillKvPairs,
  platformPrefillKvPairs,
} from './editKvFormUtils';

describe('editKvFormUtils', () => {
  it('platformPrefillKvPairs never pre-fills secret values (empty values only)', () => {
    expect(platformPrefillKvPairs(['OPENAI_API_KEY', 'ORG_ID'])).toEqual([
      { key: 'OPENAI_API_KEY', value: '' },
      { key: 'ORG_ID', value: '' },
    ]);
    expect(platformPrefillKvPairs([])).toEqual([{ key: '', value: '' }]);
    expect(platformPrefillKvPairs(undefined)).toEqual([{ key: '', value: '' }]);
  });

  it('buildKvUpdateValues filters empty fields so name-only saves omit values', () => {
    expect(
      buildKvUpdateValues([
        { key: 'OPENAI_API_KEY', value: '' },
        { key: 'ORG_ID', value: '' },
      ]),
    ).toBeUndefined();

    expect(
      buildKvUpdateValues([
        { key: 'OPENAI_API_KEY', value: '' },
        { key: 'ORG_ID', value: 'new-org' },
      ]),
    ).toEqual({ ORG_ID: 'new-org' });
  });

  it('marketPrefillKvPairs preserves decrypted plaintext for market default path', () => {
    expect(marketPrefillKvPairs({ A: 'secret-a', B: 'secret-b' })).toEqual([
      { key: 'A', value: 'secret-a' },
      { key: 'B', value: 'secret-b' },
    ]);
  });
});
