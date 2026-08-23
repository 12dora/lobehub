import { DEFAULT_SYSTEM_AGENT_CONFIG } from '@lobechat/const';
import { z } from 'zod';

import {
  type Def,
  def,
  RUNTIME_CLIENTS,
  SYSTEM_AGENT_REASONING_EFFORT_LEVELS,
  systemAgentReasoningEffortSchema,
} from './registryShared';

const SYSTEM_AGENT_REASONING_EFFORT_KEYS = [
  'topic',
  'generationTopic',
  'translation',
  'historyCompress',
  'agentMeta',
  'followUpAction',
  'inputCompletion',
  'promptRewrite',
  'memoryAnalysisAgentConfig',
  'userMemoryPersonaWriter',
] as const;
const SYSTEM_AGENT_REASONING_EFFORT_OPTIONS = SYSTEM_AGENT_REASONING_EFFORT_LEVELS.map((value) => ({
  labelKey: `settingsPolicy.options.systemAgent.reasoningEffort.${value}`,
  value,
}));

export const SYSTEM_AGENT_ENTRIES: readonly Def[] = [
  // ── systemAgent (model/provider/enabled/contextLimit/reasoningEffort — no secrets) ──
  // Service-model page keys: topic, generationTopic, translation, historyCompress,
  // agentMeta, followUpAction, inputCompletion, promptRewrite,
  // memoryAnalysisAgentConfig, userMemoryPersonaWriter, userMemoryEmbedding.
  // reasoningEffort is registered for every service-model key except embeddings.
  // `thread` is deliberately unregistered (no model/provider surface either);
  // effort stays a dormant user-settings blob field until that row is surfaced.
  ...(
    [
      'topic',
      'generationTopic',
      'translation',
      'historyCompress',
      'agentMeta',
      'followUpAction',
      'inputCompletion',
      'promptRewrite',
      'memoryAnalysisAgentConfig',
      'userMemoryPersonaWriter',
      'userMemoryEmbedding',
    ] as const
  ).flatMap((key) => {
    const item = DEFAULT_SYSTEM_AGENT_CONFIG[key];
    const surface = {
      kind: 'surface' as const,
      surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
    };
    const entries: Def[] = [
      def({
        applicableClients: RUNTIME_CLIENTS,
        builtInDefault: item.model,
        control: 'text',
        descriptionKey: `settingsPolicy.paths.systemAgent.${key}.model.desc`,
        group: 'systemAgent',
        path: `systemAgent.${key}.model`,
        userControlSurface: surface,
        platformPolicyEligible: true,
        schema: z.string().min(1).max(128),
        schemaVersion: 1,
        sensitivity: 'public',
        titleKey: `settingsPolicy.paths.systemAgent.${key}.model.title`,
      }),
      def({
        applicableClients: RUNTIME_CLIENTS,
        builtInDefault: item.provider,
        control: 'text',
        descriptionKey: `settingsPolicy.paths.systemAgent.${key}.provider.desc`,
        group: 'systemAgent',
        path: `systemAgent.${key}.provider`,
        userControlSurface: surface,
        platformPolicyEligible: true,
        schema: z.string().min(1).max(64),
        schemaVersion: 1,
        sensitivity: 'public',
        titleKey: `settingsPolicy.paths.systemAgent.${key}.provider.title`,
      }),
    ];

    if (key === 'followUpAction' || key === 'inputCompletion' || key === 'promptRewrite') {
      entries.push(
        def({
          applicableClients: RUNTIME_CLIENTS,
          builtInDefault: item.enabled ?? false,
          control: 'switch',
          descriptionKey: `settingsPolicy.paths.systemAgent.${key}.enabled.desc`,
          group: 'systemAgent',
          path: `systemAgent.${key}.enabled`,
          userControlSurface: surface,
          platformPolicyEligible: true,
          schema: z.boolean(),
          schemaVersion: 1,
          sensitivity: 'public',
          titleKey: `settingsPolicy.paths.systemAgent.${key}.enabled.title`,
        }),
      );
    }

    if (
      key === 'memoryAnalysisAgentConfig' ||
      key === 'userMemoryPersonaWriter' ||
      key === 'userMemoryEmbedding'
    ) {
      entries.push(
        def({
          applicableClients: RUNTIME_CLIENTS,
          builtInDefault: null,
          control: 'number',
          descriptionKey: `settingsPolicy.paths.systemAgent.${key}.contextLimit.desc`,
          group: 'systemAgent',
          max: 2_000_000,
          min: 1,
          path: `systemAgent.${key}.contextLimit`,
          userControlSurface: surface,
          platformPolicyEligible: true,
          schema: z.number().int().min(1).max(2_000_000).nullable(),
          schemaVersion: 1,
          sensitivity: 'public',
          titleKey: `settingsPolicy.paths.systemAgent.${key}.contextLimit.title`,
        }),
      );
    }

    return entries;
  }),

  // reasoningEffort is a nullable leaf, same as `systemAgent.<key>.contextLimit`:
  // admin clear writes `null` ("provider default"); builtInDefault is `null` so
  // an unset policy also reads as absent. Shared title/desc keys.
  ...SYSTEM_AGENT_REASONING_EFFORT_KEYS.map((key) =>
    def({
      applicableClients: RUNTIME_CLIENTS,
      builtInDefault: null,
      control: 'select',
      descriptionKey: 'settingsPolicy.paths.systemAgent.reasoningEffort.desc',
      group: 'systemAgent',
      options: SYSTEM_AGENT_REASONING_EFFORT_OPTIONS,
      path: `systemAgent.${key}.reasoningEffort`,
      userControlSurface: {
        kind: 'surface',
        surfaceFile: 'src/features/ServiceModel/ModelAssignmentsForm.tsx',
      },
      platformPolicyEligible: true,
      schema: systemAgentReasoningEffortSchema.nullable(),
      schemaVersion: 1,
      sensitivity: 'public',
      titleKey: 'settingsPolicy.paths.systemAgent.reasoningEffort.title',
    }),
  ),
];
