import type { LobeAgentChatConfig } from '@lobechat/types';
import { merge } from '@lobechat/utils/merge';
import { describe, expect, it } from 'vitest';

import {
  buildChatConfigEffortReplacement,
  EFFORT_CONFIG_KEYS,
  EFFORT_CONTROL_KEYS,
  EFFORT_CONTROL_REGISTRY,
} from './effortControlRegistry';

/**
 * Chat config fields that look effort-adjacent but must never be touched by the
 * replacement patch: token budgets, search, history and memory settings.
 */
const NON_EFFORT_CONFIG: Record<string, unknown> = {
  displayMode: 'chat',
  enableCompressHistory: true,
  enableHistoryCount: true,
  enableReasoning: true,
  historyCount: 8,
  reasoningBudgetToken: 4096,
  reasoningBudgetToken32k: 8192,
  searchMode: 'auto',
  thinkingBudget: 1024,
  useModelBuiltinSearch: true,
};

/** A level each control genuinely offers, so the fixture can never drift from the registry. */
const validLevelFor = (key: (typeof EFFORT_CONTROL_KEYS)[number]) =>
  EFFORT_CONTROL_REGISTRY[key].defaultLevel;

/** Every registry key set to a level it offers, plus the non-effort noise. */
const fullyConfigured = () => {
  const config: Record<string, unknown> = { ...NON_EFFORT_CONFIG };
  for (const key of EFFORT_CONTROL_KEYS) {
    config[EFFORT_CONTROL_REGISTRY[key].configKey] = validLevelFor(key);
  }
  return config as Partial<LobeAgentChatConfig>;
};

describe('EFFORT_CONFIG_KEYS', () => {
  it('covers every registry entry and excludes budget / search / history / memory fields', () => {
    expect(EFFORT_CONFIG_KEYS).toHaveLength(EFFORT_CONTROL_KEYS.length);

    for (const excluded of Object.keys(NON_EFFORT_CONFIG)) {
      expect(EFFORT_CONFIG_KEYS).not.toContain(excluded);
    }
  });
});

describe('buildChatConfigEffortReplacement', () => {
  it('inherits a level for every registry entry and drops everything else', () => {
    const expected = Object.fromEntries(
      EFFORT_CONTROL_KEYS.map((key) => [
        EFFORT_CONTROL_REGISTRY[key].configKey,
        validLevelFor(key),
      ]),
    );

    expect(buildChatConfigEffortReplacement(fullyConfigured(), {})).toEqual(expected);
  });

  it('is a no-op patch when neither side carries an effort level', () => {
    expect(
      buildChatConfigEffortReplacement(NON_EFFORT_CONFIG as Partial<LobeAgentChatConfig>),
    ).toEqual({});
    expect(buildChatConfigEffortReplacement(undefined, NON_EFFORT_CONFIG as any)).toEqual({});
    expect(buildChatConfigEffortReplacement(null, null)).toEqual({});
  });

  it('clears every registry key the target holds but the source no longer sets', () => {
    // Source keeps exactly one key; the target is fully configured.
    for (const kept of EFFORT_CONTROL_KEYS) {
      const keptConfigKey = EFFORT_CONTROL_REGISTRY[kept].configKey;
      const source = { [keptConfigKey]: validLevelFor(kept) } as Partial<LobeAgentChatConfig>;

      const patch = buildChatConfigEffortReplacement(source, fullyConfigured());

      const expected = Object.fromEntries(
        EFFORT_CONTROL_KEYS.map((key) => {
          const configKey = EFFORT_CONTROL_REGISTRY[key].configKey;
          return [configKey, configKey === keptConfigKey ? validLevelFor(kept) : null];
        }),
      );

      expect(patch).toEqual(expected);
    }
  });

  it('never emits a clear for a key the target does not carry', () => {
    const patch = buildChatConfigEffortReplacement({}, { reasoningEffort: 'high' });

    expect(patch).toEqual({ reasoningEffort: null });
  });

  it('treats a stored null on either side as "not set"', () => {
    expect(
      buildChatConfigEffortReplacement(
        { reasoningEffort: null } as any,
        {
          reasoningEffort: null,
        } as any,
      ),
    ).toEqual({});
  });
});

/**
 * The clear has to be `null`, not `undefined`: both layers that apply an agent-config
 * patch deep-merge with this exact `merge()` — the optimistic store dispatch
 * (`internal_dispatchAgentMap`) and `AgentModel.updateConfig` — and `merge()` skips
 * `undefined` source values, so an omitted or undefined key silently keeps the stale level.
 */
describe('replacement patch under the agent-config merge', () => {
  it('clears a stale level while preserving unrelated chat config', () => {
    const builderChatConfig = {
      enableHistoryCount: true,
      historyCount: 8,
      reasoningEffort: 'high',
      searchMode: 'auto',
    } as Partial<LobeAgentChatConfig>;

    const patch = buildChatConfigEffortReplacement(
      // Fresh inbox: no effort level persisted at all.
      { searchMode: 'off' } as Partial<LobeAgentChatConfig>,
      builderChatConfig,
    );

    const merged = merge({ chatConfig: builderChatConfig }, { chatConfig: patch }) as {
      chatConfig: Record<string, unknown>;
    };

    expect(merged.chatConfig.reasoningEffort).toBeNull();
    expect(merged.chatConfig.searchMode).toBe('auto');
    expect(merged.chatConfig.historyCount).toBe(8);
    expect(merged.chatConfig.enableHistoryCount).toBe(true);
  });

  it('overwrites a stale level with the inherited one', () => {
    const builderChatConfig = { reasoningEffort: 'high' } as Partial<LobeAgentChatConfig>;
    const patch = buildChatConfigEffortReplacement(
      { reasoningEffort: 'low' } as Partial<LobeAgentChatConfig>,
      builderChatConfig,
    );

    const merged = merge({ chatConfig: builderChatConfig }, { chatConfig: patch }) as {
      chatConfig: Record<string, unknown>;
    };

    expect(merged.chatConfig.reasoningEffort).toBe('low');
  });

  it('documents why `undefined` cannot be used as the clear', () => {
    const merged = merge(
      { chatConfig: { reasoningEffort: 'high' } },
      { chatConfig: { reasoningEffort: undefined } },
    ) as { chatConfig: Record<string, unknown> };

    // merge() skips undefined — the stale level survives, which is the bug this guards.
    expect(merged.chatConfig.reasoningEffort).toBe('high');
  });
});
