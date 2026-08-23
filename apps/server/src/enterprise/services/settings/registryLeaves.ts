import {
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_MEMORY_SETTINGS,
  DEFAULT_NOTIFICATION_SETTINGS,
  DEFAULT_TTS_CONFIG,
} from '@lobechat/const';
import { z } from 'zod';

import { type Def, def, RUNTIME_CLIENTS, UI_CLIENTS } from './registryShared';

const memoryEffortSchema = z.enum(['high', 'low', 'medium']);
const approvalModeSchema = z.enum(['auto-run', 'allow-list', 'manual', 'headless']);
const sttServerSchema = z.enum(['openai', 'browser']);
const sttModelSchema = z.literal('whisper-1');
const ttsModelSchema = z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);

export const MEMORY_ENTRIES: readonly Def[] = [
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_MEMORY_SETTINGS.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.memory.enabled.desc',
    group: 'memory',
    path: 'memory.enabled',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.memory.enabled.title',
  }),
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: DEFAULT_MEMORY_SETTINGS.effort ?? 'medium',
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.memory.effort.desc',
    group: 'memory',
    options: [
      { labelKey: 'settingsPolicy.options.memory.effort.low', value: 'low' },
      { labelKey: 'settingsPolicy.options.memory.effort.medium', value: 'medium' },
      { labelKey: 'settingsPolicy.options.memory.effort.high', value: 'high' },
    ],
    path: 'memory.effort',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/memory/features/Memory.tsx',
    },
    platformPolicyEligible: true,
    schema: memoryEffortSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.memory.effort.title',
  }),
];

export const TOOL_ENTRIES: readonly Def[] = [
  def({
    applicableClients: RUNTIME_CLIENTS,
    builtInDefault: 'manual' as const,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tool.humanIntervention.approvalMode.desc',
    group: 'tool',
    options: [
      { labelKey: 'settingsPolicy.options.approval.autoRun', value: 'auto-run' },
      { labelKey: 'settingsPolicy.options.approval.allowList', value: 'allow-list' },
      { labelKey: 'settingsPolicy.options.approval.manual', value: 'manual' },
      { labelKey: 'settingsPolicy.options.approval.headless', value: 'headless' },
    ],
    path: 'tool.humanIntervention.approvalMode',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/features/ChatInput/ControlBar/ApprovalMode.tsx',
    },
    platformPolicyEligible: true,
    schema: approvalModeSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tool.humanIntervention.approvalMode.title',
  }),
];

export const IMAGE_ENTRIES: readonly Def[] = [
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_IMAGE_CONFIG.defaultImageNum,
    control: 'number',
    descriptionKey: 'settingsPolicy.paths.image.defaultImageNum.desc',
    group: 'image',
    max: 20,
    min: 1,
    path: 'image.defaultImageNum',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/image/features/Image.tsx',
    },
    platformPolicyEligible: true,
    schema: z.number().int().min(1).max(20),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.image.defaultImageNum.title',
  }),
];

export const TTS_ENTRIES: readonly Def[] = [
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.sttAutoStop,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.tts.sttAutoStop.desc',
    group: 'tts',
    path: 'tts.sttAutoStop',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.sttAutoStop.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.sttServer,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.sttServer.desc',
    group: 'tts',
    options: [
      { labelKey: 'settingsPolicy.options.tts.sttServer.openai', value: 'openai' },
      { labelKey: 'settingsPolicy.options.tts.sttServer.browser', value: 'browser' },
    ],
    path: 'tts.sttServer',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: sttServerSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.sttServer.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.openAI.sttModel,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.openAI.sttModel.desc',
    group: 'tts',
    options: [{ labelKey: 'settingsPolicy.options.tts.sttModel.whisper1', value: 'whisper-1' }],
    path: 'tts.openAI.sttModel',
    userControlSurface: {
      kind: 'none',
      reason: 'No ordinary-user control; TTS settings expose only the OpenAI TTS model',
    },
    platformPolicyEligible: true,
    schema: sttModelSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.openAI.sttModel.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_TTS_CONFIG.openAI.ttsModel,
    control: 'select',
    descriptionKey: 'settingsPolicy.paths.tts.openAI.ttsModel.desc',
    group: 'tts',
    options: [
      { labelKey: 'settingsPolicy.options.tts.ttsModel.gpt4oMini', value: 'gpt-4o-mini-tts' },
      { labelKey: 'settingsPolicy.options.tts.ttsModel.tts1', value: 'tts-1' },
      { labelKey: 'settingsPolicy.options.tts.ttsModel.tts1Hd', value: 'tts-1-hd' },
    ],
    path: 'tts.openAI.ttsModel',
    userControlSurface: {
      kind: 'surface',
      surfaceFile: 'src/routes/(main)/settings/tts/features/OpenAI.tsx',
    },
    platformPolicyEligible: true,
    schema: ttsModelSchema,
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.tts.openAI.ttsModel.title',
  }),
];

export const NOTIFICATION_ENTRIES: readonly Def[] = [
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_NOTIFICATION_SETTINGS.email?.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.notification.email.enabled.desc',
    group: 'notification',
    path: 'notification.email.enabled',
    userControlSurface: {
      kind: 'none',
      reason: 'Notification settings page is a null business stub with no user control',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.notification.email.enabled.title',
  }),
  def({
    applicableClients: UI_CLIENTS,
    builtInDefault: DEFAULT_NOTIFICATION_SETTINGS.inbox?.enabled ?? true,
    control: 'switch',
    descriptionKey: 'settingsPolicy.paths.notification.inbox.enabled.desc',
    group: 'notification',
    path: 'notification.inbox.enabled',
    userControlSurface: {
      kind: 'none',
      reason: 'Notification settings page is a null business stub with no user control',
    },
    platformPolicyEligible: true,
    schema: z.boolean(),
    schemaVersion: 1,
    sensitivity: 'public',
    titleKey: 'settingsPolicy.paths.notification.inbox.enabled.title',
  }),
];
