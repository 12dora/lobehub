import type {
  PlatformAgentDependencySnapshot,
  PlatformAgentModelDependencyRef,
  PlatformAgentSkillDependencyRef,
} from '@lobechat/types';

import type { AdminAgentDraftDependencies } from './types';

/**
 * Pure resolution + snapshot-building for the exact platform-agent dependency snapshot.
 *
 * The exact `providerRevision`/`providerChecksum`, skill `checksum`/`version`, etc. are ALWAYS
 * sourced from the real published catalog reads (see useDependencyCatalog). Nothing here
 * fabricates a revision or checksum — an unresolvable published revision yields `null` so the
 * UI can surface it as unavailable instead of inventing values the server would reject.
 */

/** Structurally-minimal view of a published provider list row (from admin.aiProviders.list). */
export interface PublishedProviderSummary {
  displayName: string;
  id: string;
  providerKey: string;
}

/** A published model option (from admin.aiProviders.get → published.models). */
export interface PublishedModelOption {
  displayName: string | null;
  modelKey: string;
  type: string;
}

/** The published provider detail we consume (admin.aiProviders.get → published). */
export interface ProviderPublishedDetail {
  models: PublishedModelOption[];
  providerKey: string;
  revision: number;
}

/** A provider revision-history row (from admin.aiProviders.listRevisions). */
export interface ProviderRevisionRef {
  checksum: string;
  revision: number;
  status: string;
}

/** A published skill option (from platform.skills.getPublishedCatalog → skills). */
export interface PublishedSkillOption {
  checksum: string;
  displayName: string;
  distribution: string;
  skillKey: string;
  version: string;
}

/** The resolved exact model source: provider identity + exact published revision/checksum. */
export interface ResolvedProviderModelSource {
  chatModels: PublishedModelOption[];
  providerChecksum: string;
  providerKey: string;
  providerRevision: number;
}

/**
 * Join a published provider detail with its revision history to recover the EXACT published
 * `providerRevision` + `providerChecksum` pair (validated together server-side). Returns `null`
 * when the published revision has no matching published checksum — callers MUST treat this as
 * "catalog unavailable" rather than fabricate a value.
 */
export const resolveProviderModelSource = (
  detail: ProviderPublishedDetail | null | undefined,
  revisions: readonly ProviderRevisionRef[],
): ResolvedProviderModelSource | null => {
  if (!detail) return null;
  const match = revisions.find((r) => r.revision === detail.revision && r.status === 'published');
  if (!match) return null;
  return {
    chatModels: detail.models.filter((model) => model.type === 'chat'),
    providerChecksum: match.checksum,
    providerKey: detail.providerKey,
    providerRevision: detail.revision,
  };
};

/** Build the exact model dependency ref from a resolved source and a chosen model key. */
export const buildModelDependency = (
  source: ResolvedProviderModelSource,
  modelKey: string,
): PlatformAgentModelDependencyRef => ({
  modelKey,
  providerChecksum: source.providerChecksum,
  providerKey: source.providerKey,
  providerRevision: source.providerRevision,
});

/** Build the exact skill dependency ref from a published skill option. */
export const buildSkillDependency = (
  skill: PublishedSkillOption,
): PlatformAgentSkillDependencyRef => ({
  checksum: skill.checksum,
  skillKey: skill.skillKey,
  version: skill.version,
});

/**
 * Replace the ENTIRE model ref. Switching provider or model never keeps stale
 * revision/checksum metadata from the previous selection.
 */
export const withModel = (
  dependencies: AdminAgentDraftDependencies,
  model: PlatformAgentModelDependencyRef | null,
): AdminAgentDraftDependencies => ({ ...dependencies, model });

/** Add (or replace, keyed by skillKey) a skill dependency ref. */
export const withSkillAdded = (
  dependencies: AdminAgentDraftDependencies,
  skill: PlatformAgentSkillDependencyRef,
): AdminAgentDraftDependencies =>
  dependencies.skills.some((existing) => existing.skillKey === skill.skillKey)
    ? {
        ...dependencies,
        skills: dependencies.skills.map((existing) =>
          existing.skillKey === skill.skillKey ? skill : existing,
        ),
      }
    : { ...dependencies, skills: [...dependencies.skills, skill] };

/** Remove a skill dependency ref by skillKey. */
export const withSkillRemoved = (
  dependencies: AdminAgentDraftDependencies,
  skillKey: string,
): AdminAgentDraftDependencies => ({
  ...dependencies,
  skills: dependencies.skills.filter((existing) => existing.skillKey !== skillKey),
});

/**
 * Build the exact contract snapshot for `appendVersion`, or `null` when the required model has
 * not been resolved yet (so the caller blocks the save with a clear message).
 */
export const toDependencySnapshot = (
  dependencies: AdminAgentDraftDependencies,
): PlatformAgentDependencySnapshot | null =>
  dependencies.model
    ? {
        connectors: dependencies.connectors,
        model: dependencies.model,
        skills: dependencies.skills,
      }
    : null;
