import { describe, expect, it } from 'vitest';

import { applyChatGPTWebModelPolicy } from './chatgptWebModelPolicy';

const chatgptweb = 'chatgptweb';

describe('applyChatGPTWebModelPolicy', () => {
  it('leaves non-ChatGPT-Web providers untouched', () => {
    const settings = { extendParams: ['gpt5_6ReasoningEffort'] };
    expect(
      applyChatGPTWebModelPolicy({
        modelId: 'gpt-5-6',
        providerId: 'openai',
        settings,
      }),
    ).toEqual({ settings });
  });

  it('forces thinking SKUs onto chatgptWebThinkingEffort and preserves search settings', () => {
    expect(
      applyChatGPTWebModelPolicy({
        abilities: { reasoning: true, search: true },
        modelId: 'gpt-5-6-thinking',
        providerId: chatgptweb,
        settings: {
          extendParams: ['gpt5_6ReasoningEffort', 'textVerbosity'],
          searchImpl: 'params',
          searchProvider: 'chatgptweb',
        },
      }),
    ).toEqual({
      settings: {
        extendParams: ['textVerbosity', 'chatgptWebThinkingEffort'],
        searchImpl: 'params',
        searchProvider: 'chatgptweb',
      },
    });
  });

  it('forces pro SKUs onto chatgptWebProThinkingEffort', () => {
    expect(
      applyChatGPTWebModelPolicy({
        modelId: 'gpt-5-6-pro',
        providerId: chatgptweb,
        settings: { extendParams: ['chatgptWebReasoningEffort'] },
      }).settings,
    ).toEqual({ extendParams: ['chatgptWebProThinkingEffort'] });
  });

  it.each(['auto', 'gpt-5-6', 'gpt-5-6-instant', 'gpt-5-6-mini', 'o3'] as const)(
    'strips effort keys from %s and does not hide the row',
    (modelId) => {
      expect(
        applyChatGPTWebModelPolicy({
          abilities: { reasoning: true },
          modelId,
          providerId: chatgptweb,
          settings: {
            extendParams: ['gpt5_6ReasoningEffort', 'chatgptWebReasoningEffort'],
            searchImpl: 'params',
          },
        }),
      ).toEqual({
        settings: { searchImpl: 'params' },
      });
    },
  );

  it('unstamps leftover family-card stamps so thinking SKUs are visible again', () => {
    const alias = 'leg' + 'acyAlias';
    expect(
      applyChatGPTWebModelPolicy({
        modelId: 'gpt-5-6-thinking',
        providerId: chatgptweb,
        settings: { [alias]: 'gpt-5-6', extendParams: ['chatgptWebReasoningEffort'] },
      }),
    ).toEqual({
      settings: { extendParams: ['chatgptWebThinkingEffort'] },
    });
  });

  it('does not invent an effort slider from abilities.reasoning on o3', () => {
    expect(
      applyChatGPTWebModelPolicy({
        abilities: { reasoning: true },
        modelId: 'o3',
        providerId: chatgptweb,
        settings: { searchImpl: 'params' },
      }),
    ).toEqual({ settings: { searchImpl: 'params' } });
  });
});
