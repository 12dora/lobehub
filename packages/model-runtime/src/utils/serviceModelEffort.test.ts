import { GenerateObjectEffortParamsSchema } from '@lobechat/types';
import { describe, expect, it } from 'vitest';

import {
  pickGenerateObjectEffortParams,
  projectServiceModelEffort,
  readExtendParamsFromModelCards,
} from './serviceModelEffort';

describe('projectServiceModelEffort', () => {
  it('returns {} when the service model stores no level', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['gpt5_6ReasoningEffort'],
        model: 'gpt-5.6',
        reasoningEffort: undefined,
      }),
    ).toEqual({});
  });

  it('returns {} for an explicit null clear', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['gpt5_6ReasoningEffort'],
        model: 'gpt-5.6',
        reasoningEffort: null,
      }),
    ).toEqual({});
  });

  it('returns {} when the model exposes no discrete effort control', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['enableReasoning', 'reasoningBudgetToken'],
        model: 'gpt-5.6',
        reasoningEffort: 'high',
      }),
    ).toEqual({});
  });

  it('returns {} when the model has no extend params at all', () => {
    expect(
      projectServiceModelEffort({
        extendParams: undefined,
        model: 'gpt-5.6',
        reasoningEffort: 'high',
      }),
    ).toEqual({});
  });

  it('maps the stored level onto the wire param the control declares', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['gpt5_6ReasoningEffort'],
        model: 'gpt-5.6',
        reasoningEffort: 'xhigh',
      }),
    ).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('clamps a level the current model no longer offers back to the control default', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['grok4_5ReasoningEffort'],
        model: 'grok-4.5',
        reasoningEffort: 'max',
      }),
    ).toEqual({ reasoning_effort: 'high' });
  });

  it('emits only the resolved control, never params for options it did not configure', () => {
    const result = projectServiceModelEffort({
      extendParams: ['enableAdaptiveThinking', 'enableReasoning', 'reasoningBudgetToken', 'effort'],
      model: 'claude-opus-4-6',
      reasoningEffort: 'high',
    });

    expect(result).toEqual({ effort: 'high' });
    expect(result).not.toHaveProperty('thinking');
  });

  it('routes through the control the registry prioritises when several are present', () => {
    expect(
      projectServiceModelEffort({
        extendParams: ['thinking', 'thinkingLevel'],
        model: 'gemini-3-pro',
        reasoningEffort: 'low',
      }),
    ).toEqual({ thinkingLevel: 'low' });
  });

  it('projects Hunyuan HY3 no_think onto reasoning_effort and passes the wire schema', () => {
    const projected = pickGenerateObjectEffortParams(
      projectServiceModelEffort({
        extendParams: ['hy3ReasoningEffort'],
        model: 'hunyuan-hy3',
        reasoningEffort: 'no_think',
      }),
    );

    expect(projected).toEqual({ reasoning_effort: 'no_think' });
    expect(GenerateObjectEffortParamsSchema.parse(projected)).toEqual(projected);
  });

  it.each(['standard', 'extended', 'max'] as const)(
    'projects ChatGPT Web %s onto chatgptWebThinkingEffort and passes the wire schema',
    (level) => {
      const projected = pickGenerateObjectEffortParams(
        projectServiceModelEffort({
          extendParams: ['chatgptWebThinkingEffort'],
          model: 'gpt-5-6-thinking',
          reasoningEffort: level,
        }),
      );

      expect(projected).toEqual({ chatgptWebThinkingEffort: level });
      expect(GenerateObjectEffortParamsSchema.parse(projected)).toEqual(projected);
    },
  );

  it('projects ChatGPT Web Pro onto chatgptWebProThinkingEffort', () => {
    const projected = pickGenerateObjectEffortParams(
      projectServiceModelEffort({
        extendParams: ['chatgptWebProThinkingEffort'],
        model: 'gpt-5-6-pro',
        reasoningEffort: 'standard',
      }),
    );

    expect(projected).toEqual({ chatgptWebProThinkingEffort: 'standard' });
    expect(GenerateObjectEffortParamsSchema.parse(projected)).toEqual(projected);
  });

  it('drops ChatGPT Web thinking effort when the current model is not a thinking SKU', () => {
    const projected = pickGenerateObjectEffortParams(
      projectServiceModelEffort({
        extendParams: ['gpt5_6ReasoningEffort'],
        model: 'gpt-5.6',
        reasoningEffort: 'extended',
      }),
    );

    expect(projected).not.toHaveProperty('chatgptWebThinkingEffort');
    expect(projected).not.toHaveProperty('chatgptWebProThinkingEffort');
    expect(projected).toEqual({ reasoning_effort: 'medium' });
  });
});

describe('pickGenerateObjectEffortParams', () => {
  it('omits undefined keys so callers can spread without leaking empties', () => {
    expect(pickGenerateObjectEffortParams({})).toEqual({});
    expect(pickGenerateObjectEffortParams({ reasoning_effort: 'high' })).toEqual({
      reasoning_effort: 'high',
    });
  });

  it('drops unknown enum values instead of forwarding them', () => {
    expect(
      pickGenerateObjectEffortParams({
        effort: 'turbo',
        reasoning_effort: 'ludicrous',
        thinking: { type: 'maybe' },
        thinkingLevel: 'ultra',
      }),
    ).toEqual({});
  });

  it('keeps a valid thinking type and drops an unknown one', () => {
    expect(
      pickGenerateObjectEffortParams({
        thinking: { budget_tokens: 2048, type: 'enabled' },
      }),
    ).toEqual({ thinking: { budget_tokens: 2048, type: 'enabled' } });

    expect(
      pickGenerateObjectEffortParams({
        thinking: { budget_tokens: 512, type: 'bogus' },
      }),
    ).toEqual({ thinking: { budget_tokens: 512 } });
  });

  it('drops thinking: disabled when a discrete effort control is also present', () => {
    expect(
      pickGenerateObjectEffortParams({
        effort: 'high',
        thinking: { type: 'disabled' },
      }),
    ).toEqual({ effort: 'high' });
  });

  it('copies a valid chatgptWebThinkingEffort and drops an unknown one', () => {
    expect(pickGenerateObjectEffortParams({ chatgptWebThinkingEffort: 'extended' })).toEqual({
      chatgptWebThinkingEffort: 'extended',
    });
    expect(pickGenerateObjectEffortParams({ chatgptWebThinkingEffort: 'turbo' })).toEqual({});
    expect(pickGenerateObjectEffortParams({ chatgptWebProThinkingEffort: 'standard' })).toEqual({
      chatgptWebProThinkingEffort: 'standard',
    });
    expect(pickGenerateObjectEffortParams({ chatgptWebProThinkingEffort: 'max' })).toEqual({});
  });

  it('keeps thinking: enabled alongside reasoning_effort (DeepSeek coexistence)', () => {
    expect(
      pickGenerateObjectEffortParams({
        reasoning_effort: 'high',
        thinking: { type: 'enabled' },
      }),
    ).toEqual({ reasoning_effort: 'high', thinking: { type: 'enabled' } });
  });
});

const cards = [
  {
    id: 'gpt-5.6',
    providerId: 'openai',
    settings: { extendParams: ['gpt5_6ReasoningEffort'] },
  },
  {
    id: 'gpt-5.6',
    providerId: 'lobehub',
    settings: { extendParams: [] as string[] },
  },
  {
    id: 'gpt-5.6',
    providerId: 'cometapi',
    settings: { extendParams: [] as string[] },
  },
];

describe('readExtendParamsFromModelCards', () => {
  it('matches by model id and provider id', () => {
    expect(readExtendParamsFromModelCards(cards, 'gpt-5.6', 'openai')).toEqual([
      'gpt5_6ReasoningEffort',
    ]);
  });

  it('falls back to a same-id canonical card for aggregation providers', () => {
    expect(readExtendParamsFromModelCards(cards, 'gpt-5.6', 'lobehub')).toEqual([
      'gpt5_6ReasoningEffort',
    ]);
  });

  it("does not inherit another provider's controls for a non-aggregator empty card", () => {
    expect(readExtendParamsFromModelCards(cards, 'gpt-5.6', 'cometapi')).toBeUndefined();
  });

  it('returns undefined when the model is missing', () => {
    expect(readExtendParamsFromModelCards(cards, 'unknown-model', 'openai')).toBeUndefined();
  });
});
