import { describe, expect, it } from 'vitest';

import {
  restoreNoticeKeyForIntent,
  secretEditFromIntent,
  secretIntentFromEdit,
} from './connectorSecretIntent';

describe('secretIntentFromEdit', () => {
  it('records the operator decision, and remembers an unsatisfied reentry', () => {
    expect(secretIntentFromEdit({ operation: 'clear', value: '' }, false)).toBe('clear');
    expect(secretIntentFromEdit({ operation: 'replace', value: 'x' }, false)).toBe(
      'replace_requires_reentry',
    );
    expect(secretIntentFromEdit({ operation: 'keep', value: '' }, false)).toBe('keep');
    // A restored replacement that was never re-entered must survive another crash.
    expect(secretIntentFromEdit({ operation: 'keep', value: '' }, true)).toBe(
      'replace_requires_reentry',
    );
  });
});

describe('secretEditFromIntent', () => {
  it('restores a clear, but never a replacement (bytes are not stored)', () => {
    expect(secretEditFromIntent('clear')).toEqual({ operation: 'clear', value: '' });
    expect(secretEditFromIntent('replace_requires_reentry')).toEqual({
      operation: 'keep',
      value: '',
    });
    expect(secretEditFromIntent('keep')).toEqual({ operation: 'keep', value: '' });
    expect(secretEditFromIntent(undefined)).toEqual({ operation: 'keep', value: '' });
  });
});

describe('restoreNoticeKeyForIntent', () => {
  it('warns only for the two recoverable secret intents', () => {
    expect(restoreNoticeKeyForIntent('replace_requires_reentry')).toBe(
      'connectorCatalog.unsaved.secretReentry',
    );
    expect(restoreNoticeKeyForIntent('clear')).toBe('connectorCatalog.unsaved.secretClearRestored');
    expect(restoreNoticeKeyForIntent('keep')).toBeNull();
    expect(restoreNoticeKeyForIntent(undefined)).toBeNull();
  });
});
