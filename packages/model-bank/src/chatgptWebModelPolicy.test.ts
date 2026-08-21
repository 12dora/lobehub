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

  it('forces family ids onto exactly chatgptWebReasoningEffort and preserves search settings', () => {
    expect(
      applyChatGPTWebModelPolicy({
        abilities: { reasoning: true, search: true },
        modelId: 'gpt-5-6',
        providerId: chatgptweb,
        settings: {
          extendParams: ['gpt5_6ReasoningEffort', 'textVerbosity'],
          searchImpl: 'params',
          searchProvider: 'chatgptweb',
        },
      }),
    ).toEqual({
      settings: {
        extendParams: ['chatgptWebReasoningEffort'],
        searchImpl: 'params',
        searchProvider: 'chatgptweb',
      },
    });
  });

  it('stamps empty family settings with the family control', () => {
    expect(
      applyChatGPTWebModelPolicy({
        modelId: 'gpt-5-5',
        providerId: chatgptweb,
        settings: {},
      }).settings,
    ).toEqual({ extendParams: ['chatgptWebReasoningEffort'] });
  });

  it.each(['auto', 'gpt-5-6-instant', 'gpt-5-6-thinking', 'gpt-5-6-pro'] as const)(
    'strips effort keys from %s, stamps legacyAlias, and hides the picker row',
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
        settings: {
          legacyAlias: 'gpt-5-6',
          searchImpl: 'params',
        },
        visible: false,
      });
    },
  );

  it('aliases gpt-5-5 SKUs onto the gpt-5-5 family', () => {
    expect(
      applyChatGPTWebModelPolicy({
        modelId: 'gpt-5-5-pro',
        providerId: chatgptweb,
        settings: { extendParams: ['chatgptWebReasoningEffort'] },
      }),
    ).toEqual({
      settings: { legacyAlias: 'gpt-5-5' },
      visible: false,
    });
  });

  it.each(['o3', 'gpt-5-6-mini'] as const)(
    'strips effort keys from %s without hiding the row',
    (modelId) => {
      expect(
        applyChatGPTWebModelPolicy({
          abilities: { reasoning: true },
          modelId,
          providerId: chatgptweb,
          settings: {
            extendParams: ['gpt5_6ReasoningEffort', 'chatgptWebReasoningEffort'],
            searchImpl: 'params',
            searchProvider: 'chatgptweb',
          },
        }),
      ).toEqual({
        settings: { searchImpl: 'params', searchProvider: 'chatgptweb' },
      });
    },
  );

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
