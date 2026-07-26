import { describe, expect, it } from 'vitest';

import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { isPlatformSettingMetaWritable } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { SystemAgentItem } from '@/types/user/settings';

import { SYSTEM_AGENT_POLICY_PATHS } from './ModelAssignmentsForm';
import {
  getSystemAgentPatchMetas,
  isSystemAgentPolicyRowHidden,
  type SystemAgentPolicyMetas,
} from './ModelAssignmentsFormView';

const meta = (overrides: Partial<PlatformSettingMetaState> = {}): PlatformSettingMetaState => ({
  canReset: false,
  enabled: true,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: 'default',
  reset: async () => false,
  resetError: null,
  resetting: false,
  retry: async () => undefined,
  source: 'platform',
  status: 'ready',
  ...overrides,
});

describe('Service Model managed policy coverage', () => {
  const registeredPaths = Object.entries(SYSTEM_AGENT_POLICY_PATHS).flatMap(([agent, fields]) =>
    fields.map((field) => `systemAgent.${agent}.${field}`),
  );

  it('covers every one of the 28 registered system-agent leaf paths exactly once', () => {
    expect(registeredPaths).toHaveLength(28);
    expect(new Set(registeredPaths).size).toBe(28);
    expect(registeredPaths).toMatchInlineSnapshot(`
      [
        "systemAgent.agentMeta.model",
        "systemAgent.agentMeta.provider",
        "systemAgent.followUpAction.model",
        "systemAgent.followUpAction.provider",
        "systemAgent.followUpAction.enabled",
        "systemAgent.generationTopic.model",
        "systemAgent.generationTopic.provider",
        "systemAgent.historyCompress.model",
        "systemAgent.historyCompress.provider",
        "systemAgent.inputCompletion.model",
        "systemAgent.inputCompletion.provider",
        "systemAgent.inputCompletion.enabled",
        "systemAgent.memoryAnalysisAgentConfig.model",
        "systemAgent.memoryAnalysisAgentConfig.provider",
        "systemAgent.memoryAnalysisAgentConfig.contextLimit",
        "systemAgent.promptRewrite.model",
        "systemAgent.promptRewrite.provider",
        "systemAgent.promptRewrite.enabled",
        "systemAgent.topic.model",
        "systemAgent.topic.provider",
        "systemAgent.translation.model",
        "systemAgent.translation.provider",
        "systemAgent.userMemoryEmbedding.model",
        "systemAgent.userMemoryEmbedding.provider",
        "systemAgent.userMemoryEmbedding.contextLimit",
        "systemAgent.userMemoryPersonaWriter.model",
        "systemAgent.userMemoryPersonaWriter.provider",
        "systemAgent.userMemoryPersonaWriter.contextLimit",
      ]
    `);
  });

  it.each([
    ['model', { model: 'model' }],
    ['provider', { provider: 'provider' }],
    ['enabled', { enabled: true }],
    ['contextLimit', { contextLimit: 8192 }],
  ] as const)('selects only the governing metadata for a %s write', (field, patch) => {
    const model = meta();
    const provider = meta();
    const enabled = meta();
    const contextLimit = meta();
    const policy: SystemAgentPolicyMetas = {
      contextLimit,
      enabled,
      modelProvider: [model, provider],
    };

    const selected = getSystemAgentPatchMetas(policy, patch as Partial<SystemAgentItem>);
    expect(selected).toEqual(
      field === 'model' || field === 'provider'
        ? [model, provider]
        : [field === 'enabled' ? enabled : contextLimit],
    );
  });

  it.each(['loading', 'error'] as const)('fails closed while metadata is %s', (status) => {
    expect(isPlatformSettingMetaWritable(meta({ locked: true, status }))).toBe(false);
  });

  it('blocks locked fields and hides the complete governed row for a hidden leaf', () => {
    expect(isPlatformSettingMetaWritable(meta({ locked: true }))).toBe(false);
    expect(
      isSystemAgentPolicyRowHidden({
        contextLimit: meta({ hidden: true }),
        modelProvider: [meta(), meta()],
      }),
    ).toBe(true);
  });
});
