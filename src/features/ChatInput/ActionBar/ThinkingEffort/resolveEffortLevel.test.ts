import { EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';
import { describe, expect, it } from 'vitest';

import { resolveCurrentEffortLevel, resolveDefaultEffortLevel } from './resolveEffortLevel';

describe('resolveDefaultEffortLevel', () => {
  it('falls back to the registry default', () => {
    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.reasoningEffort,
        key: 'reasoningEffort',
        model: 'o3',
      }),
    ).toBe('medium');

    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel4,
        key: 'thinkingLevel4',
        model: 'gemini-flash-latest',
      }),
    ).toBe('minimal');
  });

  it('uses the model-specific thinkingLevel default', () => {
    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel,
        key: 'thinkingLevel',
        model: 'gemini-flash-latest',
      }),
    ).toBe('medium');

    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel,
        key: 'thinkingLevel',
        model: 'gemini-3.5-flash-lite',
      }),
    ).toBe('minimal');
  });

  it('keeps the generic thinkingLevel default for models without an override', () => {
    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel,
        key: 'thinkingLevel',
        model: 'gemini-3.0-pro',
      }),
    ).toBe('high');

    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel,
        key: 'thinkingLevel',
      }),
    ).toBe('high');
  });

  it('defaults gpt5_2ReasoningEffort to medium on gpt-5.5 only', () => {
    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.gpt5_2ReasoningEffort,
        key: 'gpt5_2ReasoningEffort',
        model: 'gpt-5.5',
      }),
    ).toBe('medium');

    expect(
      resolveDefaultEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.gpt5_2ReasoningEffort,
        key: 'gpt5_2ReasoningEffort',
        model: 'gpt-5.2',
      }),
    ).toBe('none');
  });
});

describe('resolveCurrentEffortLevel', () => {
  it('returns the persisted level when the control still offers it', () => {
    expect(
      resolveCurrentEffortLevel({
        config: { gpt5_2ReasoningEffort: 'xhigh' },
        definition: EFFORT_CONTROL_REGISTRY.gpt5_2ReasoningEffort,
        key: 'gpt5_2ReasoningEffort',
        model: 'gpt-5.5',
      }),
    ).toBe('xhigh');
  });

  it('falls back to the model-specific default when the persisted level is not offered', () => {
    expect(
      resolveCurrentEffortLevel({
        // `max` belongs to another family's control — it is not offered here.
        config: { gpt5_2ReasoningEffort: 'max' } as never,
        definition: EFFORT_CONTROL_REGISTRY.gpt5_2ReasoningEffort,
        key: 'gpt5_2ReasoningEffort',
        model: 'gpt-5.5',
      }),
    ).toBe('medium');
  });

  it('falls back to the default when nothing is persisted', () => {
    expect(
      resolveCurrentEffortLevel({
        config: {},
        definition: EFFORT_CONTROL_REGISTRY.thinkingLevel,
        key: 'thinkingLevel',
        model: 'gemini-flash-lite-latest',
      }),
    ).toBe('minimal');

    expect(
      resolveCurrentEffortLevel({
        definition: EFFORT_CONTROL_REGISTRY.effort,
        key: 'effort',
        model: 'claude-opus-4-6',
      }),
    ).toBe('high');
  });
});
