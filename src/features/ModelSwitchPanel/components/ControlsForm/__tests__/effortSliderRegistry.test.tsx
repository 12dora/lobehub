/**
 * Guards the single-source-of-truth refactor: every discrete-level slider must
 * render exactly the levels (and pick the default) that `EFFORT_CONTROL_REGISTRY`
 * declares for its key. Rendered in controlled mode (an `onChange` prop) so no
 * agent-store access is needed.
 */
import { EFFORT_CONTROL_REGISTRY, type EffortControlKey } from '@lobechat/model-runtime';
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import CodexMaxReasoningEffortSlider from '../CodexMaxReasoningEffortSlider';
import DeepSeekReasoningEffortSlider from '../DeepSeekReasoningEffortSlider';
import EffortSlider from '../EffortSlider';
import GLM52ReasoningEffortSlider from '../GLM52ReasoningEffortSlider';
import GPT5ReasoningEffortSlider from '../GPT5ReasoningEffortSlider';
import GPT51ReasoningEffortSlider from '../GPT51ReasoningEffortSlider';
import GPT52ProReasoningEffortSlider from '../GPT52ProReasoningEffortSlider';
import GPT52ReasoningEffortSlider from '../GPT52ReasoningEffortSlider';
import { GPT56ReasoningEffortSlider } from '../GPT56ReasoningEffortSlider';
import Grok43ReasoningEffortSlider from '../Grok43ReasoningEffortSlider';
import Grok45ReasoningEffortSlider from '../Grok45ReasoningEffortSlider';
import Grok420ReasoningEffortSlider from '../Grok420ReasoningEffortSlider';
import Hy3ReasoningEffortSlider from '../Hy3ReasoningEffortSlider';
import { KimiK3ReasoningEffortSlider } from '../KimiK3ReasoningEffortSlider';
import Opus47EffortSlider from '../Opus47EffortSlider';
import ReasoningEffortSlider from '../ReasoningEffortSlider';
import Ring26ReasoningEffortSlider from '../Ring26ReasoningEffortSlider';
import Step3_5ReasoningEffortSlider from '../Step3_5ReasoningEffortSlider';
import ThinkingLevel2Slider from '../ThinkingLevel2Slider';
import ThinkingLevel3Slider from '../ThinkingLevel3Slider';
import ThinkingLevel4Slider from '../ThinkingLevel4Slider';
import ThinkingLevelSlider from '../ThinkingLevelSlider';
import ThinkingSlider from '../ThinkingSlider';

const cases: [EffortControlKey, ComponentType<any>][] = [
  ['codexMaxReasoningEffort', CodexMaxReasoningEffortSlider],
  ['deepseekV4ReasoningEffort', DeepSeekReasoningEffortSlider],
  ['effort', EffortSlider],
  ['glm5_2ReasoningEffort', GLM52ReasoningEffortSlider],
  ['gpt5ReasoningEffort', GPT5ReasoningEffortSlider],
  ['gpt5_1ReasoningEffort', GPT51ReasoningEffortSlider],
  ['gpt5_2ProReasoningEffort', GPT52ProReasoningEffortSlider],
  ['gpt5_2ReasoningEffort', GPT52ReasoningEffortSlider],
  ['gpt5_6ReasoningEffort', GPT56ReasoningEffortSlider],
  ['grok4_20ReasoningEffort', Grok420ReasoningEffortSlider],
  ['grok4_3ReasoningEffort', Grok43ReasoningEffortSlider],
  ['grok4_5ReasoningEffort', Grok45ReasoningEffortSlider],
  ['hy3ReasoningEffort', Hy3ReasoningEffortSlider],
  ['kimiK3ReasoningEffort', KimiK3ReasoningEffortSlider],
  ['opus47Effort', Opus47EffortSlider],
  ['reasoningEffort', ReasoningEffortSlider],
  ['ring2_6ReasoningEffort', Ring26ReasoningEffortSlider],
  ['step3_5ReasoningEffort', Step3_5ReasoningEffortSlider],
  ['thinkingLevel', ThinkingLevelSlider],
  ['thinkingLevel2', ThinkingLevel2Slider],
  ['thinkingLevel3', ThinkingLevel3Slider],
  ['thinkingLevel4', ThinkingLevel4Slider],
];

describe('effort sliders follow EFFORT_CONTROL_REGISTRY', () => {
  it.each(cases)('%s renders the registry levels and default', (key, Slider) => {
    const { levels, defaultLevel } = EFFORT_CONTROL_REGISTRY[key];

    const { unmount } = render(<Slider onChange={vi.fn()} />);

    const labels = [...document.querySelectorAll('button[type="button"]')].map(
      (node) => node.textContent,
    );

    expect(labels).toEqual([...levels]);
    expect(screen.getByText(defaultLevel)).toHaveAttribute('aria-current', 'true');

    unmount();
  });

  // The tri-state used to carry its own hardcoded English OFF / Auto / ON marks, which
  // both skipped i18n and gave the same three values a third wording. It now goes through
  // the shared level copy like every other effort control.
  it('thinking names its registry levels with the shared level copy, not private marks', () => {
    const { levels, defaultLevel } = EFFORT_CONTROL_REGISTRY.thinking;

    expect([...levels]).toEqual(['disabled', 'auto', 'enabled']);
    expect(defaultLevel).toBe('auto');

    render(<ThinkingSlider onChange={vi.fn()} />);

    const labels = [...document.querySelectorAll('button[type="button"]')].map(
      (node) => node.textContent,
    );

    // No `setting` resources are loaded in tests, so each label falls back to its raw level.
    expect(labels).toEqual([...levels]);
    expect(labels).not.toContain('OFF');
    expect(screen.getByText(defaultLevel)).toHaveAttribute('aria-current', 'true');
  });
});
