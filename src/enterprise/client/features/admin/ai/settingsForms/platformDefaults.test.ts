import { DEFAULT_AGENT, DEFAULT_SYSTEM_AGENT_CONFIG } from '@lobechat/const';
import { describe, expect, it } from 'vitest';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

import {
  buildDefaultAgentFromPolicies,
  buildSystemAgentFromPolicies,
  defaultAgentEffortPatch,
  defaultAgentEffortRemovePaths,
  isUnpublishedSettingsDraftError,
  systemAgentPatch,
} from './platformDefaults';

type PolicyMap = AdminSettingsGetDraftOutput['publishedPolicies'];

const policies = (entries: Record<string, unknown>): PolicyMap =>
  Object.fromEntries(
    Object.entries(entries).map(([path, value]) => [path, { value }]),
  ) as PolicyMap;

describe('defaultAgentEffortPatch', () => {
  it('encodes a concrete chatConfig effort level onto the matching registry path', () => {
    expect(defaultAgentEffortPatch('gpt5_6ReasoningEffort', 'high')).toEqual({
      'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort': 'high',
    });
  });

  it('encodes a clear as removePaths so applyImmediate can delete the row', () => {
    expect(defaultAgentEffortRemovePaths('thinking')).toEqual([
      'defaultAgent.config.chatConfig.thinking',
    ]);
  });
});

describe('buildDefaultAgentFromPolicies — effort read-back', () => {
  it('copies published effort leaves onto defaultAgent.config.chatConfig', () => {
    const result = buildDefaultAgentFromPolicies(
      policies({
        'defaultAgent.config.chatConfig.gpt5_6ReasoningEffort': 'high',
        'defaultAgent.config.model': 'gpt-5.6',
        'defaultAgent.config.provider': 'openai',
      }),
    );

    expect(result.config.model).toBe('gpt-5.6');
    expect(result.config.provider).toBe('openai');
    expect(result.config.chatConfig?.gpt5_6ReasoningEffort).toBe('high');
  });

  it('leaves effort keys unset when no policy exists for them', () => {
    const result = buildDefaultAgentFromPolicies(policies({}));

    expect(result.config.model).toBe(DEFAULT_AGENT.config.model);
    expect(result.config.chatConfig?.gpt5_6ReasoningEffort).toBeUndefined();
    expect(result.config.chatConfig?.enableStreaming).toBe(
      DEFAULT_AGENT.config.chatConfig?.enableStreaming,
    );
  });

  it('round-trips a patch back onto chatConfig without stealing streaming/historyCount', () => {
    const patch = defaultAgentEffortPatch('grok4_5ReasoningEffort', 'medium');
    const result = buildDefaultAgentFromPolicies(
      policies({
        ...patch,
        'defaultAgent.config.chatConfig.enableStreaming': false,
      }),
    );

    expect(result.config.chatConfig?.grok4_5ReasoningEffort).toBe('medium');
    expect(result.config.chatConfig?.enableStreaming).toBe(
      DEFAULT_AGENT.config.chatConfig?.enableStreaming,
    );
  });
});

describe('systemAgentPatch', () => {
  it('maps explicit contextLimit clear (undefined) to null', () => {
    expect(systemAgentPatch('memoryAnalysisAgentConfig', { contextLimit: undefined })).toEqual({
      'systemAgent.memoryAnalysisAgentConfig.contextLimit': null,
    });
  });

  it('maps numeric contextLimit and ignores omitted keys', () => {
    expect(
      systemAgentPatch('userMemoryEmbedding', {
        contextLimit: 8192,
        model: 'text-embedding-3-small',
      }),
    ).toEqual({
      'systemAgent.userMemoryEmbedding.contextLimit': 8192,
      'systemAgent.userMemoryEmbedding.model': 'text-embedding-3-small',
    });
  });

  it('does not emit contextLimit when the field is absent from the partial', () => {
    expect(systemAgentPatch('topic', { model: 'gpt-4o', provider: 'openai' })).toEqual({
      'systemAgent.topic.model': 'gpt-4o',
      'systemAgent.topic.provider': 'openai',
    });
  });

  it('encodes a chosen reasoningEffort level', () => {
    expect(systemAgentPatch('topic', { reasoningEffort: 'high' })).toEqual({
      'systemAgent.topic.reasoningEffort': 'high',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ] as const)('encodes a reasoningEffort clear (%s) as null', (_label, cleared) => {
    expect(systemAgentPatch('historyCompress', { reasoningEffort: cleared })).toEqual({
      'systemAgent.historyCompress.reasoningEffort': null,
    });
  });

  it('does not emit reasoningEffort when the field is absent from the partial', () => {
    expect(systemAgentPatch('topic', { enabled: true })).toEqual({
      'systemAgent.topic.enabled': true,
    });
  });

  it('carries reasoningEffort alongside the other leaves in one patch', () => {
    expect(
      systemAgentPatch('memoryAnalysisAgentConfig', {
        contextLimit: 4096,
        enabled: true,
        model: 'gpt-4o',
        provider: 'openai',
        reasoningEffort: 'low',
      }),
    ).toEqual({
      'systemAgent.memoryAnalysisAgentConfig.contextLimit': 4096,
      'systemAgent.memoryAnalysisAgentConfig.enabled': true,
      'systemAgent.memoryAnalysisAgentConfig.model': 'gpt-4o',
      'systemAgent.memoryAnalysisAgentConfig.provider': 'openai',
      'systemAgent.memoryAnalysisAgentConfig.reasoningEffort': 'low',
    });
  });
});

describe('buildSystemAgentFromPolicies — reasoningEffort read-back', () => {
  it('reads a stored level back onto the item', () => {
    const result = buildSystemAgentFromPolicies(
      policies({ 'systemAgent.topic.reasoningEffort': 'high' }),
    );

    expect(result.topic.reasoningEffort).toBe('high');
  });

  it('treats a null platform value as unset rather than surfacing null to the picker', () => {
    const result = buildSystemAgentFromPolicies(
      policies({ 'systemAgent.topic.reasoningEffort': null }),
    );

    expect(result.topic.reasoningEffort).toBeUndefined();
    expect('reasoningEffort' in result.topic).toBe(false);
  });

  it('leaves reasoningEffort unset when no policy exists for it', () => {
    expect(buildSystemAgentFromPolicies(policies({})).topic.reasoningEffort).toBeUndefined();
  });

  it('preserves model / provider / enabled / contextLimit while reading reasoningEffort', () => {
    const result = buildSystemAgentFromPolicies(
      policies({
        'systemAgent.memoryAnalysisAgentConfig.contextLimit': 4096,
        'systemAgent.memoryAnalysisAgentConfig.enabled': true,
        'systemAgent.memoryAnalysisAgentConfig.model': 'gpt-4o',
        'systemAgent.memoryAnalysisAgentConfig.provider': 'openai',
        'systemAgent.memoryAnalysisAgentConfig.reasoningEffort': 'low',
      }),
    );

    expect(result.memoryAnalysisAgentConfig).toMatchObject({
      contextLimit: 4096,
      enabled: true,
      model: 'gpt-4o',
      provider: 'openai',
      reasoningEffort: 'low',
    });
  });

  it('clearing reasoningEffort does not disturb the sibling leaves', () => {
    const result = buildSystemAgentFromPolicies(
      policies({
        'systemAgent.memoryAnalysisAgentConfig.contextLimit': 4096,
        'systemAgent.memoryAnalysisAgentConfig.model': 'gpt-4o',
        'systemAgent.memoryAnalysisAgentConfig.provider': 'openai',
        'systemAgent.memoryAnalysisAgentConfig.reasoningEffort': null,
      }),
    );

    expect(result.memoryAnalysisAgentConfig).toMatchObject({
      contextLimit: 4096,
      model: 'gpt-4o',
      provider: 'openai',
    });
    expect(result.memoryAnalysisAgentConfig.reasoningEffort).toBeUndefined();
  });

  it('falls back to the built-in defaults for keys with no policy at all', () => {
    const result = buildSystemAgentFromPolicies(policies({}));

    expect(result.topic.model).toBe(DEFAULT_SYSTEM_AGENT_CONFIG.topic.model);
    expect(result.topic.provider).toBe(DEFAULT_SYSTEM_AGENT_CONFIG.topic.provider);
  });
});

describe('isUnpublishedSettingsDraftError', () => {
  it('detects structured PLATFORM_INVALID_INPUT with unpublished_draft_outside_patch', () => {
    expect(
      isUnpublishedSettingsDraftError({
        data: {
          errorData: {
            code: 'PLATFORM_INVALID_INPUT',
            details: { reason: 'unpublished_draft_outside_patch', dirtyPathCount: 1 },
          },
        },
      }),
    ).toBe(true);
  });

  it('detects SettingsDirtyDraftError by name/message', () => {
    const err = Object.assign(
      new Error('Unpublished settings draft differs outside the applied patch.'),
      {
        name: 'SettingsDirtyDraftError',
      },
    );
    expect(isUnpublishedSettingsDraftError(err)).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isUnpublishedSettingsDraftError(new Error('boom'))).toBe(false);
    expect(
      isUnpublishedSettingsDraftError({
        data: { errorData: { code: 'PLATFORM_PERMISSION_DENIED' } },
      }),
    ).toBe(false);
  });
});
