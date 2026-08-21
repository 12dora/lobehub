import { describe, expect, it } from 'vitest';

import { isAiModelVisible, isLegacyAliasModel, projectPickerVisibility } from './aiModel';

describe('legacy-alias picker visibility', () => {
  it('treats a string legacyAlias as a hidden picker row', () => {
    expect(isLegacyAliasModel({ legacyAlias: 'gpt-5-6' })).toBe(true);
    expect(projectPickerVisibility({ legacyAlias: 'gpt-5-6' })).toEqual({ visible: false });
    expect(isAiModelVisible({ ...projectPickerVisibility({ legacyAlias: 'gpt-5-6' }) })).toBe(
      false,
    );
  });

  it('leaves ordinary settings visible', () => {
    expect(isLegacyAliasModel({ extendParams: ['chatgptWebReasoningEffort'] })).toBe(false);
    expect(projectPickerVisibility({})).toEqual({});
    expect(isAiModelVisible({})).toBe(true);
    expect(isLegacyAliasModel(undefined)).toBe(false);
  });
});
