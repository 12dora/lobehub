import type {
  PlatformAgentConnectorDependencyRef,
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

// ---- connectors (exact authoring from the M09 published catalog) ----

/** A published connector list row (from admin.connectors.list). */
export interface PublishedConnectorSummary {
  displayName: string;
  id: string;
  key: string;
}

/** A published connector tool (from admin.connectors.get → published.tools). */
export interface PublishedConnectorTool {
  platformPolicy: string;
  toolKey: string;
}

/** The exact published connector detail consumed to author a connector ref. */
export interface PublishedConnectorDetail {
  connectorId: string;
  connectorKey: string;
  publishedChecksum: string;
  publishedRevision: number;
  tools: PublishedConnectorTool[];
}

/** Tools an agent may reference: every published tool whose platform policy is not `deny`. */
export const allowedConnectorToolKeys = (detail: PublishedConnectorDetail): string[] =>
  detail.tools.filter((tool) => tool.platformPolicy !== 'deny').map((tool) => tool.toolKey);

/** Build the exact connector dependency ref from a published connector detail + chosen tools. */
export const buildConnectorDependency = (
  detail: PublishedConnectorDetail,
  allowedToolKeys: string[],
): PlatformAgentConnectorDependencyRef => ({
  allowedToolKeys,
  connectorId: detail.connectorId,
  connectorKey: detail.connectorKey,
  publishedChecksum: detail.publishedChecksum,
  publishedRevision: detail.publishedRevision,
});

/** Add (or replace, keyed by connectorKey) a connector dependency ref. */
export const withConnectorAdded = (
  dependencies: AdminAgentDraftDependencies,
  connector: PlatformAgentConnectorDependencyRef,
): AdminAgentDraftDependencies =>
  dependencies.connectors.some((existing) => existing.connectorKey === connector.connectorKey)
    ? {
        ...dependencies,
        connectors: dependencies.connectors.map((existing) =>
          existing.connectorKey === connector.connectorKey ? connector : existing,
        ),
      }
    : { ...dependencies, connectors: [...dependencies.connectors, connector] };

/** Remove a connector dependency ref by connectorKey. */
export const withConnectorRemoved = (
  dependencies: AdminAgentDraftDependencies,
  connectorKey: string,
): AdminAgentDraftDependencies => ({
  ...dependencies,
  connectors: dependencies.connectors.filter((existing) => existing.connectorKey !== connectorKey),
});

// ---- validation of existing refs against the CURRENTLY fetched published catalog ----

/**
 * A model ref is "current" only when it matches the freshly-resolved published source EXACTLY:
 * same provider key + published revision + checksum, and the model is still an offered chat model.
 * Non-null alone is NOT sufficient (a stale checksum/revision would fail server validation).
 */
export const isModelCurrent = (
  model: PlatformAgentModelDependencyRef | null,
  source: ResolvedProviderModelSource | null | undefined,
): boolean =>
  !!model &&
  !!source &&
  model.providerKey === source.providerKey &&
  model.providerRevision === source.providerRevision &&
  model.providerChecksum === source.providerChecksum &&
  source.chatModels.some((option) => option.modelKey === model.modelKey);

/** Order-independent canonical form of a tool-key set (dedup + sort). */
const canonicalToolSet = (toolKeys: readonly string[]): string =>
  [...new Set(toolKeys)].sort().join(' ');

/**
 * A skill ref is current only when EVERY contract field (skillKey + version + checksum) still
 * matches a published skill. FAIL-CLOSED: an undefined catalog (loading / error / initial /
 * unsettled) can never be verified, so the ref is treated as stale.
 */
export const staleSkillKeys = (
  skills: readonly PlatformAgentSkillDependencyRef[],
  published: readonly PublishedSkillOption[] | undefined,
): string[] =>
  skills
    .filter(
      (skill) =>
        !published ||
        !published.some(
          (option) =>
            option.skillKey === skill.skillKey &&
            option.version === skill.version &&
            option.checksum === skill.checksum,
        ),
    )
    .map((skill) => skill.skillKey);

/**
 * A connector ref is current only when the COMPLETE authoritative tuple matches the freshly
 * fetched published detail: connectorId, connectorKey, publishedChecksum, publishedRevision, and
 * the canonical allowed-tool set (after deny/deleted tools are excluded). `null` detail
 * (missing / unpublished / not yet fetched) is never current.
 */
export const isConnectorCurrent = (
  ref: PlatformAgentConnectorDependencyRef,
  detail: PublishedConnectorDetail | null | undefined,
): boolean =>
  !!detail &&
  ref.connectorId === detail.connectorId &&
  ref.connectorKey === detail.connectorKey &&
  ref.publishedChecksum === detail.publishedChecksum &&
  ref.publishedRevision === detail.publishedRevision &&
  canonicalToolSet(ref.allowedToolKeys) === canonicalToolSet(allowedConnectorToolKeys(detail));

/**
 * connectorKeys whose exact tuple no longer matches the published catalog. `detailsById` maps a
 * referenced connectorId to its freshly fetched detail (`null` when unpublished/missing).
 * FAIL-CLOSED: an undefined map (loading / error / unsettled) treats every ref as stale.
 */
export const staleConnectorKeys = (
  connectors: readonly PlatformAgentConnectorDependencyRef[],
  detailsById: Readonly<Record<string, PublishedConnectorDetail | null>> | undefined,
): string[] =>
  connectors
    .filter(
      (connector) =>
        !detailsById || !isConnectorCurrent(connector, detailsById[connector.connectorId]),
    )
    .map((connector) => connector.connectorKey);
