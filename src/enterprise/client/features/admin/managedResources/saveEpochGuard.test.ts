import { describe, expect, it } from 'vitest';

import { shouldPreserveLocalDraftAfterSave } from './controller';

describe('shouldPreserveLocalDraftAfterSave', () => {
  it('keeps local draft when epoch advanced during in-flight save', () => {
    expect(shouldPreserveLocalDraftAfterSave(3, 4)).toBe(true);
  });

  it('accepts the saved snapshot when no concurrent edit occurred', () => {
    expect(shouldPreserveLocalDraftAfterSave(7, 7)).toBe(false);
  });

  it('documents the same epoch guard used after the post-save refresh', () => {
    // Save captures submittedEpoch before mutate(); concurrent UI edits bump the ref.
    // Applying refreshed draft only when epochs match prevents clobbering newer local policy edits.
    const submittedEpoch = 10;
    const epochAfterUserEditDuringRefresh = 11;
    expect(shouldPreserveLocalDraftAfterSave(submittedEpoch, epochAfterUserEditDuringRefresh)).toBe(
      true,
    );
    expect(shouldPreserveLocalDraftAfterSave(submittedEpoch, submittedEpoch)).toBe(false);
  });
});
