import { describe, expect, it } from 'vitest';

import { isUnpublishedSettingsDraftError, systemAgentPatch } from './platformDefaults';

describe('systemAgentPatch', () => {
  it('maps explicit contextLimit clear (undefined) to null', () => {
    expect(systemAgentPatch('memoryAnalysisAgentConfig', { contextLimit: undefined })).toEqual({
      'systemAgent.memoryAnalysisAgentConfig.contextLimit': null,
    });
  });

  it('maps numeric contextLimit and ignores omitted keys', () => {
    expect(
      systemAgentPatch('userMemoryEmbedding', {
        contextLimit: 8192,
        model: 'text-embedding-3-small',
      }),
    ).toEqual({
      'systemAgent.userMemoryEmbedding.contextLimit': 8192,
      'systemAgent.userMemoryEmbedding.model': 'text-embedding-3-small',
    });
  });

  it('does not emit contextLimit when the field is absent from the partial', () => {
    expect(systemAgentPatch('topic', { model: 'gpt-4o', provider: 'openai' })).toEqual({
      'systemAgent.topic.model': 'gpt-4o',
      'systemAgent.topic.provider': 'openai',
    });
  });
});

describe('isUnpublishedSettingsDraftError', () => {
  it('detects structured PLATFORM_INVALID_INPUT with unpublished_draft_outside_patch', () => {
    expect(
      isUnpublishedSettingsDraftError({
        data: {
          errorData: {
            code: 'PLATFORM_INVALID_INPUT',
            details: { reason: 'unpublished_draft_outside_patch', dirtyPathCount: 1 },
          },
        },
      }),
    ).toBe(true);
  });

  it('detects SettingsDirtyDraftError by name/message', () => {
    const err = Object.assign(
      new Error('Unpublished settings draft differs outside the applied patch.'),
      {
        name: 'SettingsDirtyDraftError',
      },
    );
    expect(isUnpublishedSettingsDraftError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUnpublishedSettingsDraftError(new Error('boom'))).toBe(false);
    expect(
      isUnpublishedSettingsDraftError({
        data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
      }),
    ).toBe(false);
  });
});
