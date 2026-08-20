import { describe, expect, it } from 'vitest';

import { pickGenerateObjectEffortParams, projectServiceModelEffort } from './serviceModelEffort';

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
});

describe('pickGenerateObjectEffortParams', () => {
  it('omits undefined keys so callers can spread without leaking empties', () => {
    expect(pickGenerateObjectEffortParams({})).toEqual({});
    expect(pickGenerateObjectEffortParams({ reasoning_effort: 'high' })).toEqual({
      reasoning_effort: 'high',
    });
  });
});
