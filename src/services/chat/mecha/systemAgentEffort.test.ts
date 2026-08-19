import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as aiInfraStore from '@/store/aiInfra';
import * as aiModelSelectors from '@/store/aiInfra/slices/aiModel/selectors';

import { resolveSystemAgentEffortParams, withSystemAgentEffortParams } from './systemAgentEffort';

const mockAiInfraStoreState = { someState: true };

const mockExtendParams = (extendParams: string[] | undefined) => {
  vi.spyOn(aiModelSelectors.aiModelSelectors, 'modelExtendParams').mockReturnValue(
    () => extendParams as never,
  );
};

const item = (reasoningEffort?: string | null) => ({
  model: 'gpt-5.6',
  provider: 'openai',
  reasoningEffort: reasoningEffort as never,
});

describe('resolveSystemAgentEffortParams', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(aiInfraStore, 'getAiInfraStoreState').mockReturnValue(mockAiInfraStoreState as never);
  });

  it('returns {} when the service model stores no level', () => {
    mockExtendParams(['gpt5_6ReasoningEffort']);

    expect(resolveSystemAgentEffortParams(item())).toEqual({});
  });

  it('returns {} for an explicit null clear', () => {
    mockExtendParams(['gpt5_6ReasoningEffort']);

    expect(resolveSystemAgentEffortParams(item(null))).toEqual({});
  });

  it('drops a null level rather than putting it on the wire', () => {
    mockExtendParams(['gpt5_6ReasoningEffort']);

    expect(withSystemAgentEffortParams({ ...item(null), model: 'gpt-5.6' })).toEqual({
      model: 'gpt-5.6',
      provider: 'openai',
    });
  });

  it('returns {} for an undefined item', () => {
    expect(resolveSystemAgentEffortParams(undefined)).toEqual({});
  });

  it('returns {} when the model exposes no discrete effort control', () => {
    mockExtendParams(['enableReasoning', 'reasoningBudgetToken']);

    expect(resolveSystemAgentEffortParams(item('high'))).toEqual({});
  });

  it('returns {} when the model has no extend params at all', () => {
    mockExtendParams(undefined);

    expect(resolveSystemAgentEffortParams(item('high'))).toEqual({});
  });

  it('maps the stored level onto the wire param the control declares', () => {
    mockExtendParams(['gpt5_6ReasoningEffort']);

    expect(resolveSystemAgentEffortParams(item('xhigh'))).toEqual({ reasoning_effort: 'xhigh' });
  });

  it('clamps a level the current model no longer offers back to the control default', () => {
    // grok4_5ReasoningEffort offers low|medium|high (default high) — `max` is not offered.
    mockExtendParams(['grok4_5ReasoningEffort']);

    expect(resolveSystemAgentEffortParams(item('max'))).toEqual({ reasoning_effort: 'high' });
  });

  it('emits only the resolved control, never params for options it did not configure', () => {
    // Claude-shaped card: `enableReasoning` is absent from the synthetic chatConfig, which the
    // projector would otherwise read as "reasoning explicitly off" and pair a contradictory
    // `thinking: { type: 'disabled' }` with the effort we asked for.
    mockExtendParams([
      'enableAdaptiveThinking',
      'enableReasoning',
      'reasoningBudgetToken',
      'effort',
    ]);

    const result = resolveSystemAgentEffortParams(item('high'));

    expect(result).toEqual({ effort: 'high' });
    expect(result).not.toHaveProperty('thinking');
  });

  it('routes through the control the registry prioritises when several are present', () => {
    // Real effort keys win over the tri-state `thinking` toggle.
    mockExtendParams(['thinking', 'thinkingLevel']);

    expect(resolveSystemAgentEffortParams(item('low'))).toEqual({ thinkingLevel: 'low' });
  });
});
