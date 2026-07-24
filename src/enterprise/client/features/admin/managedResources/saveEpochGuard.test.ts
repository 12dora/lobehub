import { describe, expect, it } from 'vitest';

import { shouldPreserveLocalDraftAfterSave } from './controller';

describe('shouldPreserveLocalDraftAfterSave', () => {
  it('keeps local draft when epoch advanced during in-flight save', () => {
    expect(shouldPreserveLocalDraftAfterSave(3, 4)).toBe(true);
  });

  it('accepts the saved snapshot when no concurrent edit occurred', () => {
    expect(shouldPreserveLocalDraftAfterSave(7, 7)).toBe(false);
  });
});
