import type { PlatformAgentVersionConfig } from '@lobechat/types';
import type { z } from 'zod';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  type ManagedResourcePolicySnapshot,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform/checksum';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { platformAgentEffectiveListOutputSchema } from '../../contracts/platformAgents';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { PlatformAgentNotFoundError } from './errors';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;
type EffectiveAgent = EffectiveList['agents'][number];
type Distribution = EffectiveAgent['distribution'];

/**
 * Immutable, copy-safe exact-version snapshot captured at the start of one operation (R2).
 * A caller pins this value for the whole operation and never re-resolves the current pointer,
 * so publishing v2 mid-flight cannot swap the version out from under an in-progress operation.
 * The object and its `config` are deep-frozen; a caller mutation cannot pollute the resolver
 * or a later snapshot.
 */
export interface PlatformAgentOperationSnapshot {
  checksum: string;
  config: PlatformAgentVersionConfig;
  platformAgentId: string;
  versionId: string;
}

/**
 * Operation-scoped handle (R2). Wraps a single captured snapshot; `getSnapshot()` replays that
 * exact frozen value for the whole operation and never re-resolves the current pointer.
 */
export interface PlatformAgentOperationHandle {
  getSnapshot: () => PlatformAgentOperationSnapshot;
  readonly platformAgentId: string;
}

/** Authorized (assignment-resolved) Agent before per-user hidden filtering. */
interface AuthorizedAgent {
  agentKey: string;
  checksum: string;
  config: PlatformAgentVersionConfig;
  distribution: Distribution;
  platformAgentId: string;
  systemKey: 'default-inbox' | null;
  version: string;
  versionId: string;
}

type ResolverRepository = Pick<
  PlatformAgentCatalogRepository,
  'listEffectiveInputs' | 'listHiddenPlatformAgentIds'
>;

interface PlatformAgentEffectiveResolverOptions {
  flags?: EnterpriseFeatureFlags;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  repository?: ResolverRepository;
}

const isAgentRuntimeManaged = (snapshot: ManagedResourcePolicySnapshot): boolean =>
  snapshot.status === 'published' &&
  snapshot.published.agents.managed &&
  snapshot.published.agents.enforcementMode === 'enforced';

const emptyEffectiveList = (): EffectiveList => {
  const agents: EffectiveList['agents'] = [];
  return { agents, revision: checksumPayload({ agents }) };
};

/** Recursively freeze a structured-cloned value so no caller can mutate a captured snapshot. */
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
};

const projectEffective = (agent: AuthorizedAgent): EffectiveAgent => ({
  agentKey: agent.agentKey,
  checksum: agent.checksum,
  config: agent.config,
  distribution: agent.distribution,
  mutable: false,
  platformAgentId: agent.platformAgentId,
  source: 'platform',
  systemKey: agent.systemKey,
  version: agent.version,
  versionId: agent.versionId,
});

/** User-safe effective platform Agent projection. Feature/policy-off paths never query Agent rows. */
export class PlatformAgentEffectiveResolver {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly options: PlatformAgentEffectiveResolverOptions = {},
  ) {}

  private repository = (): ResolverRepository =>
    this.options.repository ?? new PlatformAgentCatalogRepository(this.db);

  /**
   * Authorization-only resolution: the assignment-scoped, de-duplicated Agents a user is
   * entitled to (server-authoritative role/scope/expiry filtering lives in the repository
   * query). Does NOT apply per-user hidden filtering — that is a list-view concern applied
   * by `getEffectiveList`, not an authorization boundary.
   */
  private resolveAuthorized = async (userId: string): Promise<AuthorizedAgent[]> => {
    const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return [];

    const policy = await (
      this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
    ).getSnapshot();
    if (!isAgentRuntimeManaged(policy)) return [];

    const rows = await this.repository().listEffectiveInputs(userId);
    rows.sort(
      (left, right) =>
        right.targetPriority - left.targetPriority ||
        left.agent.agentKey.localeCompare(right.agent.agentKey) ||
        left.assignment.id.localeCompare(right.assignment.id),
    );
    const seenAgents = new Set<string>();
    const seenSystemKeys = new Set<string>();
    const authorized: AuthorizedAgent[] = [];
    for (const row of rows) {
      if (seenAgents.has(row.agent.id)) continue;
      if (row.agent.systemKey && seenSystemKeys.has(row.agent.systemKey)) continue;
      seenAgents.add(row.agent.id);
      if (row.agent.systemKey) seenSystemKeys.add(row.agent.systemKey);
      authorized.push({
        agentKey: row.agent.agentKey,
        checksum: row.version.checksum,
        config: row.version.config,
        distribution: row.assignment.mode,
        platformAgentId: row.agent.id,
        systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
        version: row.version.version,
        versionId: row.version.id,
      });
    }
    return authorized;
  };

  getEffectiveList = async (userId: string): Promise<EffectiveList> => {
    const authorized = await this.resolveAuthorized(userId);
    if (authorized.length === 0) return emptyEffectiveList();

    // Owner-scoped hidden read: mandatory Agents ignore hidden (always visible); default /
    // optional Agents respect the requesting user's own hidden choices (R1).
    const hidden = await this.repository().listHiddenPlatformAgentIds(userId);
    const agents = authorized
      .filter((agent) => agent.distribution === 'mandatory' || !hidden.has(agent.platformAgentId))
      .map(projectEffective);
    return { agents, revision: checksumPayload({ agents }) };
  };

  getEffectiveAgent = async (userId: string, platformAgentId: string) => {
    const { agents } = await this.getEffectiveList(userId);
    return agents.find((agent) => agent.platformAgentId === platformAgentId) ?? null;
  };

  /**
   * Capture an immutable operation snapshot ONCE against the authorization set (not the
   * hidden-filtered list). The only capture entry point; callers reach it through
   * `beginOperation`, never re-resolving mid-operation. Returns null when the user is not
   * entitled to the Agent — no assignment / target / role metadata is exposed.
   */
  private captureOperationSnapshot = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformAgentOperationSnapshot | null> => {
    const authorized = await this.resolveAuthorized(userId);
    const target = authorized.find((agent) => agent.platformAgentId === platformAgentId);
    if (!target) return null;
    return deepFreeze<PlatformAgentOperationSnapshot>(
      structuredClone({
        checksum: target.checksum,
        config: target.config,
        platformAgentId: target.platformAgentId,
        versionId: target.versionId,
      }),
    );
  };

  /**
   * Begin an operation-scoped boundary (R2). Captures the exact version exactly once, then
   * returns a handle whose `getSnapshot()` only ever replays that frozen capture — there is no
   * path to re-resolve current/latest within a handle, so publishing v2 cannot swap the version
   * out from under an in-flight operation. A fresh `beginOperation` is the only way to capture a
   * newer version. The handle is a frozen closure over an immutable value — no global cache, no
   * cross-request state, nothing to leak. Returns null when the user is not entitled to the Agent.
   */
  beginOperation = async (
    userId: string,
    platformAgentId: string,
  ): Promise<PlatformAgentOperationHandle | null> => {
    const snapshot = await this.captureOperationSnapshot(userId, platformAgentId);
    if (!snapshot) return null;
    return Object.freeze<PlatformAgentOperationHandle>({
      getSnapshot: () => snapshot,
      platformAgentId: snapshot.platformAgentId,
    });
  };

  /**
   * Owner-scoped visibility write. Only ever acts on the trusted `userId`'s own row (there is
   * no target-user parameter to forge), and only for an Agent the user is entitled to. Hiding a
   * mandatory Agent is accepted but has no read effect — mandatory always stays visible.
   *
   * If the Agent is archived between authorization and the write (a lost archive race), the
   * repository returns false under its per-Agent lock and this maps to a stable NotFound rather
   * than silently succeeding (R1-02).
   */
  setAgentHidden = async (
    userId: string,
    platformAgentId: string,
    hidden: boolean,
  ): Promise<void> => {
    const authorized = await this.resolveAuthorized(userId);
    const target = authorized.find((agent) => agent.platformAgentId === platformAgentId);
    if (!target) throw new PlatformAgentNotFoundError();
    const written = await new PlatformAgentCatalogRepository(this.db).setMaterializationHidden({
      hidden,
      platformAgentId: target.platformAgentId,
      platformAgentVersionChecksum: target.checksum,
      platformAgentVersionId: target.versionId,
      userId,
    });
    if (!written) throw new PlatformAgentNotFoundError();
  };
}
