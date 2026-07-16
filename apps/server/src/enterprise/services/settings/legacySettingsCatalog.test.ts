// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { validateLegacySettingsUpdate } from './legacySettingsCatalog';

describe('strict legacy settings catalog (B4-R2)', () => {
  it.each([
    [
      'Advanced disableGatewayMode sparse patch',
      { defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } } },
    ],
    [
      'model/provider/system role and all released LLM params',
      {
        defaultAgent: {
          config: {
            model: 'gpt-4o-mini',
            params: {
              frequency_penalty: 0.2,
              max_tokens: 4096,
              presence_penalty: 0.1,
              reasoning_effort: 'high',
              temperature: 0.7,
              top_p: 0.9,
            },
            provider: 'openai',
            systemRole: 'hi',
          },
        },
      },
    ],
    [
      'released chatConfig nested fields',
      {
        defaultAgent: {
          config: {
            chatConfig: {
              enableStreaming: true,
              historyCount: 12,
              memory: { effort: 'high', enabled: true, toolPermission: 'read-only' },
              runtimeEnv: { workingDirectory: '/workspace' },
              searchFCModel: { model: 'gpt-4o-mini', provider: 'openai' },
              selfIteration: { enabled: true },
              toolMode: 'agent',
            },
          },
        },
      },
    ],
    [
      'released config and metadata presentation fields',
      {
        defaultAgent: {
          config: {
            avatar: '🤖',
            backgroundColor: '#fff',
            openingMessage: 'Hello',
            openingQuestions: ['Help me'],
            plugins: ['search', { identifier: 'memory', mode: 'disabled' }],
            title: 'Assistant',
            tts: {
              showAllLocaleVoice: true,
              sttLocale: 'en-US',
              ttsService: 'openai',
              voice: { openai: 'alloy' },
            },
            virtual: false,
          },
          meta: {
            avatar: '🤖',
            backgroundColor: '#fff',
            description: 'desc',
            marketIdentifier: 'market-agent',
            tags: ['tag'],
            title: 'Assistant',
          },
        },
      },
    ],
  ])('accepts %s', (_name, payload) => {
    const result = validateLegacySettingsUpdate(payload);
    expect(result.ok).toBe(true);
  });

  it('preserves sparse chatConfig without injecting canonical defaults', () => {
    const result = validateLegacySettingsUpdate({
      defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        defaultAgent: { config: { chatConfig: { disableGatewayMode: true } } },
      });
    }
  });

  it('rejects unknown nested defaultAgent.config field with zero-write semantics', () => {
    const r = validateLegacySettingsUpdate({
      defaultAgent: {
        config: { model: 'x', unknownNested: true },
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toMatch(/UNKNOWN|INVALID/);
    }
  });

  it('rejects secret-like nested general.apiKey', () => {
    const r = validateLegacySettingsUpdate({
      general: { fontSize: 14, apiKey: 'sk-x' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('MANAGED_SETTING_SECRET_PATH');
    }
  });

  it.each([
    ['meta', { defaultAgent: { meta: { title: 'A', unknownNested: true } } }],
    [
      'chatConfig memory',
      { defaultAgent: { config: { chatConfig: { memory: { enabled: true, extra: 1 } } } } },
    ],
    [
      'chatConfig runtimeEnv',
      {
        defaultAgent: {
          config: { chatConfig: { runtimeEnv: { workingDirectory: '/tmp', extra: true } } },
        },
      },
    ],
    ['params', { defaultAgent: { config: { params: { temperature: 1, extra: 1 } } } }],
    [
      'plugin object',
      {
        defaultAgent: {
          config: { plugins: [{ identifier: 'search', mode: 'pinned', extra: true }] },
        },
      },
    ],
    [
      'tts voice',
      { defaultAgent: { config: { tts: { voice: { openai: 'alloy', unknown: 'voice' } } } } },
    ],
  ])('rejects unknown nested fields in %s', (_name, payload) => {
    const result = validateLegacySettingsUpdate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toMatch(/UNKNOWN|INVALID/);
  });

  it('rejects unexpected top-level languageModel', () => {
    const r = validateLegacySettingsUpdate({
      languageModel: { openai: {} },
    });
    expect(r.ok).toBe(false);
  });
});
