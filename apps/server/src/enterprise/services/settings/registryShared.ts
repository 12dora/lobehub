import type { EffortLevel } from '@lobechat/model-runtime';
import type { SystemAgentReasoningEffort } from '@lobechat/types';
import { z } from 'zod';

import type { SettingClientSurface, SettingDefinition } from '@/types/platform/settings';

/** Appearance / preference leaves used only in user UI clients (B6-R2). */
export const UI_CLIENTS: readonly SettingClientSurface[] = ['web', 'desktop', 'mobile'];
/** Runtime-consumed model/agent/memory leaves (server + interactive clients). */
export const RUNTIME_CLIENTS: readonly SettingClientSurface[] = [
  'web',
  'desktop',
  'mobile',
  'server',
];

/**
 * Canonical discrete levels for `SystemAgentItem.reasoningEffort`.
 * Shared with `legacySettingsCatalog` so both gates cannot drift.
 */
export const SYSTEM_AGENT_REASONING_EFFORT_LEVELS = [
  'no_think',
  'disabled',
  'none',
  'minimal',
  'auto',
  'low',
  'standard',
  'medium',
  'extended',
  'high',
  'xhigh',
  'max',
  'enabled',
] as const satisfies readonly SystemAgentReasoningEffort[];

type _MissingSystemAgentReasoningEffort = Exclude<
  SystemAgentReasoningEffort,
  (typeof SYSTEM_AGENT_REASONING_EFFORT_LEVELS)[number]
>;
const _assertAllSystemAgentReasoningEffortLevels: _MissingSystemAgentReasoningEffort extends never
  ? true
  : never = true;
void _assertAllSystemAgentReasoningEffortLevels;

export const systemAgentReasoningEffortSchema = z.enum(SYSTEM_AGENT_REASONING_EFFORT_LEVELS);

/**
 * When the platform locks this path, keep the user control visible (read-only)
 * instead of hiding it. Server canonicalizes published `visibility` to `visible`.
 */
export type Def = SettingDefinition & { lockVisibly?: boolean };

/**
 * `builtInDefault` is optional so a leaf can stay absent until a policy (or user
 * override) exists. The resolver skips `undefined` effective values (`setByPath`).
 */
type RegistryEntry<T> = Omit<SettingDefinition<T>, 'builtInDefault'> & {
  builtInDefault?: T;
  lockVisibly?: boolean;
};

export const def = <T>(entry: RegistryEntry<T>): Def => entry as Def;

/** Per-key enum — not the full EffortLevel union, not nullable. */
export const effortLevelSchema = (levels: readonly EffortLevel[]) => {
  const [first, ...rest] = levels;
  if (!first) throw new Error('Effort control levels must be non-empty');
  return z.enum([first, ...rest]);
};

export const effortSelectOptions = (levels: readonly EffortLevel[]) =>
  levels.map((value) => ({
    labelKey: `settingsPolicy.options.systemAgent.reasoningEffort.${value}`,
    value,
  }));
