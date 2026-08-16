import { describe, expect, it } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { modelScopeKey, normalizeModerationSettingsResponse, parseModelScopeKey } from './types';

const settings = {
  ...createDefaultContentModerationConfig(),
  revision: 1,
  updatedAt: new Date('2026-08-17T00:00:00.000Z'),
  updatedBy: null,
};

describe('normalizeModerationSettingsResponse', () => {
  it('flattens the provider-grouped catalog the server returns', () => {
    const bundle = normalizeModerationSettingsResponse({
      catalog: [
        {
          models: [
            { displayName: 'GPT-4o mini', id: 'gpt-4o-mini' },
            { displayName: 'GPT-4o', id: 'gpt-4o' },
          ],
          provider: 'openai',
          providerName: 'OpenAI',
        },
      ],
      roles: [{ displayName: 'super_admin', name: 'super_admin' }, { name: 'auditor' }],
      settings,
    });

    expect(bundle.catalog).toEqual([
      { label: 'GPT-4o mini', model: 'gpt-4o-mini', provider: 'openai', providerLabel: 'OpenAI' },
      { label: 'GPT-4o', model: 'gpt-4o', provider: 'openai', providerLabel: 'OpenAI' },
    ]);
    expect(bundle.roles).toEqual(['super_admin', 'auditor']);
    expect(bundle.settings.revision).toBe(1);
  });

  it('accepts a bare settings view and degrades the pickers to empty sources', () => {
    const bundle = normalizeModerationSettingsResponse(settings);
    expect(bundle.catalog).toEqual([]);
    expect(bundle.roles).toEqual([]);
    expect(bundle.settings.mode).toBe('off');
  });

  it('accepts an already-flat catalog row', () => {
    const bundle = normalizeModerationSettingsResponse({
      catalog: [{ model: 'gpt-4o', provider: 'openai' }],
      settings,
    });
    expect(bundle.catalog).toEqual([
      { label: undefined, model: 'gpt-4o', provider: 'openai', providerLabel: undefined },
    ]);
  });

  it('throws on a payload that is not an object at all', () => {
    expect(() => normalizeModerationSettingsResponse(null)).toThrow(
      'CONTENT_MODERATION_SETTINGS_MALFORMED',
    );
  });
});

describe('modelScopeKey', () => {
  it('round-trips a model id that itself contains a slash', () => {
    const key = modelScopeKey('bedrock', 'anthropic/claude-3');
    expect(key).toBe('bedrock/anthropic/claude-3');
    expect(parseModelScopeKey(key)).toEqual({ model: 'anthropic/claude-3', provider: 'bedrock' });
  });

  it('rejects malformed keys', () => {
    expect(parseModelScopeKey('nope')).toBeNull();
    expect(parseModelScopeKey('/leading')).toBeNull();
    expect(parseModelScopeKey('trailing/')).toBeNull();
  });
});
