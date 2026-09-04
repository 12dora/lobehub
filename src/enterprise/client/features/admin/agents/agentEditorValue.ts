import type { PlatformAgentVersionConfig } from '@lobechat/types';

import {
  platformAgentKeySchema,
  platformAgentVersionConfigSchema,
} from '@/server/enterprise/contracts/platformAgents';

import type {
  AdminAgentDetailOutput,
  AdminAgentDraftDependencies,
  AdminAgentEditorValue,
} from './types';
import {
  selectCurrentPlatformAgentVersion,
  selectLatestPlatformAgentVersion,
} from './versionSelection';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** The contract's own identifier rule (charset AND the 128-char ceiling), never a local copy. */
export const AGENT_KEY_MAX_LENGTH = 128;
export const isAgentKeyValid = (value: string): boolean =>
  platformAgentKeySchema.safeParse(value).success;

/** Trimmed text, or null when the field is empty (the contract forbids empty strings). */
const textOrNull = (value: string | null | undefined): string | null => {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Unique, non-empty, trimmed entries — the contract rejects duplicates and blank items. */
export const normalizeList = (values: readonly string[]): string[] => [
  ...new Set(values.map((value) => value.trim()).filter(Boolean)),
];

/** Derive a contract-legal agent key from a display name (lowercase letters, digits, `._-`). */
export const suggestAgentKey = (displayName: string): string =>
  displayName
    .trim()
    .toLowerCase()
    .replaceAll(/[^\da-z._-]+/g, '-')
    .replaceAll(/-{2,}/g, '-')
    .replace(/^[^\da-z]+/, '')
    .slice(0, AGENT_KEY_MAX_LENGTH);

/**
 * A readable, contract-legal identifier for names the charset cannot carry (an all-CJK name derives
 * to an empty, illegal key). Generated once per editor so the prefilled value never shifts under
 * the admin — the identifier is permanent after create.
 */
export const createFallbackAgentKey = (): string =>
  `assistant-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;

const EMPTY_CONFIG: PlatformAgentVersionConfig = {
  avatar: null,
  backgroundColor: null,
  description: null,
  displayName: '',
  modelParameters: {},
  openingMessage: null,
  openingQuestions: [],
  systemRole: '',
  tags: [],
};

const EMPTY_DEPENDENCIES: AdminAgentDraftDependencies = {
  connectors: [],
  model: null,
  skills: [],
};

/**
 * True when the assistant HAS a published pointer but that exact version is not in the loaded
 * page. Seeding from any other version would save the wrong config under the operator's nose, so
 * the editor refuses to open the config instead of guessing.
 */
export const isCurrentAgentVersionMissing = (agent: AdminAgentDetailOutput | undefined): boolean =>
  Boolean(agent?.identity.currentVersionId) && !selectCurrentPlatformAgentVersion(agent!);

/**
 * Seed the editor from what is LIVE for assigned members: the published pointer version. The
 * newest-version fallback applies ONLY when there is no pointer at all (legacy rows created before
 * de-drafting) — never when the pointer exists but its version was not loaded.
 */
export const seedAgentEditorValue = (
  agent: AdminAgentDetailOutput | undefined,
): AdminAgentEditorValue => {
  if (!agent) return { config: { ...EMPTY_CONFIG }, dependencies: { ...EMPTY_DEPENDENCIES } };
  const version = agent.identity.currentVersionId
    ? selectCurrentPlatformAgentVersion(agent)
    : selectLatestPlatformAgentVersion(agent.versions);
  if (!version) {
    return {
      config: { ...EMPTY_CONFIG, displayName: agent.identity.agentKey },
      dependencies: { ...EMPTY_DEPENDENCIES },
    };
  }
  return {
    config: structuredClone(version.config),
    // Carry the previous version's exact model/skill/connector refs; re-picking one replaces the
    // whole ref with fresh catalog metadata.
    dependencies: {
      connectors: structuredClone(version.dependencySnapshot.connectors),
      model: structuredClone(version.dependencySnapshot.model),
      skills: structuredClone(version.dependencySnapshot.skills),
    },
  };
};

/** Contract-shaped config, or null when a required field is still missing/invalid. */
export const buildAgentConfig = (
  value: AdminAgentEditorValue,
): PlatformAgentVersionConfig | null => {
  const backgroundColor = value.config.backgroundColor?.trim() ?? '';
  const candidate: PlatformAgentVersionConfig = {
    avatar: textOrNull(value.config.avatar),
    backgroundColor: HEX_COLOR_PATTERN.test(backgroundColor) ? backgroundColor : null,
    description: textOrNull(value.config.description),
    displayName: value.config.displayName.trim(),
    modelParameters: value.config.modelParameters,
    openingMessage: textOrNull(value.config.openingMessage),
    openingQuestions: normalizeList(value.config.openingQuestions),
    systemRole: value.config.systemRole.trim(),
    tags: normalizeList(value.config.tags),
  };
  const parsed = platformAgentVersionConfigSchema.safeParse(candidate);
  return parsed.success ? (parsed.data as PlatformAgentVersionConfig) : null;
};

/**
 * The required fields that are still empty, as i18n keys. Save is disabled by four independent
 * conditions and three of them used to be invisible — this is the list the footer names so a
 * blocked Save always says what to do next.
 */
export const collectAgentMissingRequirements = ({
  agentKey,
  isCreate,
  value,
}: {
  agentKey: string;
  isCreate: boolean;
  value: AdminAgentEditorValue;
}): string[] => {
  const list: string[] = [];
  // The system prompt is deliberately absent: the contract accepts an empty one for every
  // assistant, and the platform default legitimately publishes without a prompt.
  if (value.config.displayName.trim().length === 0) list.push('agentCatalog.editor.missing.name');
  if (isCreate && !isAgentKeyValid(agentKey)) list.push('agentCatalog.editor.missing.key');
  if (!value.dependencies.model) list.push('agentCatalog.editor.missing.model');
  return list;
};
