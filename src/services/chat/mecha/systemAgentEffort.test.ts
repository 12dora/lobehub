import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as aiInfraStore from '@/store/aiInfra';

import { resolveSystemAgentEffortParams, withSystemAgentEffortParams } from './systemAgentEffort';

const item = (reasoningEffort?: string | null) => ({
  model: 'gpt-5.6',
  provider: 'openai',
  reasoningEffort: reasoningEffort as never,
});

const mockCatalog = ({
  builtinAiModelList = [],
  enabledAiModels = [],
}: {
  builtinAiModelList?: Array<{
    id: string;
    providerId: string;
    settings?: { extendParams?: string[] };
  }>;
  enabledAiModels?: Array<{
    id: string;
    providerId: string;
    settings?: { extendParams?: string[] };
  }>;
}) => {
  vi.spyOn(aiInfraStore, 'getAiInfraStoreState').mockReturnValue({
    builtinAiModelList,
    enabledAiModels,
  } as never);
};

const mockEnabledAiModels = (
  enabledAiModels: Array<{
    id: string;
    providerId: string;
    settings?: { extendParams?: string[] };
  }>,
) => {
  mockCatalog({ enabledAiModels });
};

const openaiCard = (extendParams: string[] | undefined) => ({
  id: 'gpt-5.6',
  providerId: 'openai',
  settings: extendParams ? { extendParams } : undefined,
});

describe('resolveSystemAgentEffortParams', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockEnabledAiModels([openaiCard(['gpt5_6ReasoningEffort'])]);
  });

  it('returns {} when the service model stores no level', () => {
    expect(resolveSystemAgentEffortParams(item())).toEqual({});
  });

  it('returns {} for an explicit null clear', () => {
    expect(resolveSystemAgentEffortParams(item(null))).toEqual({});
  });

  it('drops a null level rather than putting it on the wire', () => {
    expect(withSystemAgentEffortParams({ ...item(null), model: 'gpt-5.6' })).toEqual({
      model: 'gpt-5.6',
      provider: 'openai',
    });
  });

  it('returns {} for an undefined item', () => {
    expect(resolveSystemAgentEffortParams(undefined)).toEqual({});
  });

  it('returns {} when the model exposes no discrete effort control', () => {
    mockEnabledAiModels([openaiCard(['enableReasoning', 'reasoningBudgetToken'])]);

    expect(resolveSystemAgentEffortParams(item('high'))).toEqual({});
  });

  it('returns {} when the model has no extend params at all', () => {
    mockEnabledAiModels([openaiCard(undefined)]);

    expect(resolveSystemAgentEffortParams(item('high'))).toEqual({});
  });

  it('maps the stored level onto the wire param the control declares', () => {
    expect(resolveSystemAgentEffortParams(item('xhigh'))).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('clamps a level the current model no longer offers back to the control default', () => {
    mockEnabledAiModels([
      {
        id: 'gpt-5.6',
        providerId: 'openai',
        settings: { extendParams: ['grok4_5ReasoningEffort'] },
      },
    ]);

    expect(resolveSystemAgentEffortParams(item('max'))).toEqual({ reasoning_effort: 'high' });
  });

  it('emits only the resolved control, never params for options it did not configure', () => {
    mockEnabledAiModels([
      {
        id: 'gpt-5.6',
        providerId: 'openai',
        settings: {
          extendParams: [
            'enableAdaptiveThinking',
            'enableReasoning',
            'reasoningBudgetToken',
            'effort',
          ],
        },
      },
    ]);

    const result = resolveSystemAgentEffortParams(item('high'));

    expect(result).toEqual({ effort: 'high' });
    expect(result).not.toHaveProperty('thinking');
  });

  it('routes through the control the registry prioritises when several are present', () => {
    mockEnabledAiModels([
      {
        id: 'gpt-5.6',
        providerId: 'openai',
        settings: { extendParams: ['thinking', 'thinkingLevel'] },
      },
    ]);

    expect(resolveSystemAgentEffortParams(item('low'))).toEqual({ thinkingLevel: 'low' });
  });

  it('falls back to a canonical same-id card for an empty aggregator (lobehub) card', () => {
    mockEnabledAiModels([
      openaiCard(['gpt5_6ReasoningEffort']),
      { id: 'gpt-5.6', providerId: 'lobehub', settings: { extendParams: [] } },
    ]);

    expect(
      resolveSystemAgentEffortParams({
        model: 'gpt-5.6',
        provider: 'lobehub',
        reasoningEffort: 'xhigh' as never,
      }),
    ).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('falls back to a builtin canonical card when only the LobeHub card is enabled', () => {
    mockCatalog({
      builtinAiModelList: [openaiCard(['gpt5_6ReasoningEffort'])],
      enabledAiModels: [{ id: 'gpt-5.6', providerId: 'lobehub', settings: { extendParams: [] } }],
    });

    expect(
      resolveSystemAgentEffortParams({
        model: 'gpt-5.6',
        provider: 'lobehub',
        reasoningEffort: 'xhigh' as never,
      }),
    ).toEqual({ reasoning_effort: 'xhigh' });
  });

  it.each(['standard', 'extended', 'max'] as const)(
    'projects ChatGPT Web %s onto chatgptWebThinkingEffort',
    (level) => {
      mockEnabledAiModels([
        {
          id: 'gpt-5-6-thinking',
          providerId: 'chatgptweb',
          settings: { extendParams: ['chatgptWebThinkingEffort'] },
        },
      ]);

      expect(
        resolveSystemAgentEffortParams({
          model: 'gpt-5-6-thinking',
          provider: 'chatgptweb',
          reasoningEffort: level,
        }),
      ).toEqual({ chatgptWebThinkingEffort: level });
    },
  );

  it('does not emit chatgptWebThinkingEffort for a non-ChatGPT-Web model', () => {
    expect(resolveSystemAgentEffortParams(item('extended'))).toEqual({
      reasoning_effort: 'medium',
    });
    expect(resolveSystemAgentEffortParams(item('extended'))).not.toHaveProperty(
      'chatgptWebThinkingEffort',
    );
  });

  it("does not inherit another provider's controls for a non-aggregator empty card", () => {
    mockEnabledAiModels([
      openaiCard(['gpt5_6ReasoningEffort']),
      { id: 'gpt-5.6', providerId: 'cometapi', settings: { extendParams: [] } },
    ]);

    expect(
      resolveSystemAgentEffortParams({
        model: 'gpt-5.6',
        provider: 'cometapi',
        reasoningEffort: 'xhigh' as never,
      }),
    ).toEqual({});
  });
});
