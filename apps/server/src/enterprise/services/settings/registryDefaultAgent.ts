import { DEFAULT_AGENT } from '@lobechat/const';
import { EFFORT_CONTROL_KEYS, EFFORT_CONTROL_REGISTRY } from '@lobechat/model-runtime';
import { z } from 'zod';

import {
  type Def,
  def,
  effortLevelSchema,
  effortSelectOptions,
  RUNTIME_CLIENTS,
} from './registryShared';

/**
 * One primitive leaf per EffortControlKey. Path strings stay discoverable for tests
 * even though the registry entries themselves are generated from the model-runtime table.
 */
export const DEFAULT_AGENT_CHAT_CONFIG_EFFORT_PATHS = EFFORT_CONTROL_KEYS.map(
  (key) => `defaultAgent.config.chatConfig.${key}`,
);

export const DEFAULT_AGENT_ENTRIES: readonly Def[] = [
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.model,
    control: 'text',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.model.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.model',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    },
    platformPolicyEligible: true,
    schema: z.string().min(1).max(128),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.model.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.provider,
    control: 'text',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.provider.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.provider',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    },
    platformPolicyEligible: true,
    schema: z.string().min(1).max(64),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.provider.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.systemRole ?? '',
    control: 'textarea',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.systemRole.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.systemRole',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent system-role control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.string().max(32_000),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.systemRole.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.chatConfig?.enableStreaming ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.enableStreaming.desc',
    group: 'defaultAgent',
    path: 'defaultAgent.config.chatConfig.enableStreaming',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent streaming control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.enableStreaming.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.chatConfig?.historyCount ?? 20,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.historyCount.desc',
    group: 'defaultAgent',
    max: 200,
    min: 0,
    path: 'defaultAgent.config.chatConfig.historyCount',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent history-count control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.number().int().min(0).max(200),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.historyCount.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_AGENT.config.params?.temperature ?? 1,
    control: 'slider',
    descriptionKey: 'settingsPolicy.paths.defaultAgent.config.params.temperature.desc',
    group: 'defaultAgent',
    max: 2,
    min: 0,
    path: 'defaultAgent.config.params.temperature',
    userControlSurface: {
      kind: 'none',
      reason: 'No default-agent temperature control writes UserSettings.defaultAgent',
    },
    platformPolicyEligible: true,
    schema: z.number().min(0).max(2),
    schemaVersion: 1,
    sensitivity: 'public',
    step: 0.1,
    titleKey: 'settingsPolicy.paths.defaultAgent.config.params.temperature.title',
  }),

  // One select leaf per discrete thinking-effort chatConfig key. Shared title/desc;
  // per-key schema is `z.enum(definition.levels)` so a gpt-5.2-pro leaf rejects `low`.
  // No builtInDefault: materializing registry defaults (e.g. gpt5_2ReasoningEffort:'none')
  // would override model-specific runtime defaults in resolveEffortLevel. The leaf is
  // only present in chatConfig when a policy or user override exists.
  // Do not prefix-own `defaultAgent.config.chatConfig.*` — streaming/historyCount stay
  // on the settings-policy editor.
  ...EFFORT_CONTROL_KEYS.map((key) => {
    const definition = EFFORT_CONTROL_REGISTRY[key];
    return def({
      applicableClients: RUNTIME_CLIENTS,
      control: 'select',
      descriptionKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.effort.desc',
      group: 'defaultAgent',
      options: effortSelectOptions(definition.levels),
      path: `defaultAgent.config.chatConfig.${definition.configKey}`,
      userControlSurface: {
        kind: 'surface',
        surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
      },
      platformPolicyEligible: true,
      schema: effortLevelSchema(definition.levels),
      schemaVersion: 1,
      sensitivity: 'public',
      titleKey: 'settingsPolicy.paths.defaultAgent.config.chatConfig.effort.title',
    });
  }),
];
