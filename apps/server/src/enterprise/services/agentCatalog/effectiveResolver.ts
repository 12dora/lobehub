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
import {
  PlatformAgentInvalidInputError,
  PlatformAgentNotFoundError,
  redactPlatformReadError,
} from './errors';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;
type EffectiveAgent = EffectiveList['agents'][number];
type Distribution = EffectiveAgent['distribution'];

/** Matches `platformAgentEffectiveListOutputSchema.agents.max(1000)` — never exceed the wire contract. */
export const PLATFORM_AGENT_EFFECTIVE_LIST_MAX = 1000;

/**
 * Initial SQL window and expansion step for full-list resolution. Multi-target assignments
 * de-dupe to one Agent and optional rows may be hidden; the resolver expands this window until
 * {@link PLATFORM_AGENT_EFFECTIVE_LIST_MAX} visible winners are collected or the source is exhausted
 * (never a fixed one-shot multiple that can starve entitled agents past an arbitrary row cap).
 */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH = PLATFORM_AGENT_EFFECTIVE_LIST_MAX;

/** @deprecated Prefer {@link PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH}; kept as the first-page size. */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_OVERSCAN = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;

/** Hard ceiling on assignment rows scanned while filling the effective list (memory bound). */
export const PLATFORM_AGENT_EFFECTIVE_INPUT_MAX_SCAN = PLATFORM_AGENT_EFFECTIVE_LIST_MAX * 50;

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
  readonly distribution?: Distribution;
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

type EffectiveInputFilter = {
  limit?: number;
  platformAgentId?: string;
  systemKey?: string;
};

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
   *
   * Pass `filter` for single-agent / system-key lookups so the repository never scans the full
   * assignment catalog. Full-list callers MUST pass a SQL `limit` (overscan) so the repository
   * never loads an unbounded assignment set; de-dupe then returns the winner set for further
   * hidden filtering / wire-cap in `getEffectiveList`.
   */
  /**
   * Project assignment rows into de-duplicated authorized Agents in stable winner order.
   * Does not apply the wire cap or hidden filtering — callers decide those policy layers.
   */
  private projectAuthorizedRows = (
    rows: Awaited<ReturnType<ResolverRepository['listEffectiveInputs']>>,
  ): AuthorizedAgent[] => {
    const ordered = [...rows].sort(
      (left, right) =>
        right.targetPriority - left.targetPriority ||
        left.agent.agentKey.localeCompare(right.agent.agentKey) ||
        left.assignment.id.localeCompare(right.assignment.id),
    );
    const seenAgents = new Set<string>();
    const seenSystemKeys = new Set<string>();
    const authorized: AuthorizedAgent[] = [];
    for (const row of ordered) {
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

  private resolveAuthorized = async (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<AuthorizedAgent[]> => {
    const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
    if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return [];

    const policy = await (
      this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
    ).getSnapshot();
    if (!isAgentRuntimeManaged(policy)) return [];

    const rows = await this.repository().listEffectiveInputs(userId, filter);
    return this.projectAuthorizedRows(rows);
  };

  getEffectiveList = async (userId: string): Promise<EffectiveList> => {
    try {
      const flags = this.options.flags ?? parseEnterpriseFeatureFlags(process.env);
      if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return emptyEffectiveList();

      const policy = await (
        this.options.policyModel ?? new PlatformManagedResourcePolicyModel(this.db)
      ).getSnapshot();
      if (!isAgentRuntimeManaged(policy)) return emptyEffectiveList();

      // Owner-scoped hidden read once; mandatory Agents ignore hidden (always visible).
      const hidden = await this.repository().listHiddenPlatformAgentIds(userId);
      const repository = this.repository();

      // Expand the SQL window until we collect the wire max of *visible* unique winners, or the
      // source is exhausted. A fixed 5× overscan can omit entitled agents when leading rows are
      // duplicate assignments or hidden optional agents.
      let fetchLimit = PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;
      let agents: EffectiveAgent[] = [];
      for (;;) {
        const rows = await repository.listEffectiveInputs(userId, { limit: fetchLimit });
        agents = this.projectAuthorizedRows(rows)
          .filter(
            (agent) => agent.distribution === 'mandatory' || !hidden.has(agent.platformAgentId),
          )
          .slice(0, PLATFORM_AGENT_EFFECTIVE_LIST_MAX)
          .map(projectEffective);

        const sourceExhausted = rows.length < fetchLimit;
        const listFull = agents.length >= PLATFORM_AGENT_EFFECTIVE_LIST_MAX;
        if (sourceExhausted || listFull || fetchLimit >= PLATFORM_AGENT_EFFECTIVE_INPUT_MAX_SCAN) {
          break;
        }
        fetchLimit = Math.min(
          fetchLimit + PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
          PLATFORM_AGENT_EFFECTIVE_INPUT_MAX_SCAN,
        );
      }

      return { agents, revision: checksumPayload({ agents }) };
    } catch (error) {
      // Redact any unexpected driver / SQL failure at the read boundary (REWORK-5).
      throw redactPlatformReadError(error);
    }
  };

  getEffectiveAgent = async (userId: string, platformAgentId: string) => {
    try {
      // Targeted repository path — never pay for full-catalog resolution for one agent.
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      const target = authorized[0];
      if (!target) return null;
      if (target.distribution !== 'mandatory') {
        const hidden = await this.repository().listHiddenPlatformAgentIds(userId);
        if (hidden.has(platformAgentId)) return null;
      }
      return projectEffective(target);
    } catch (error) {
      // Same redaction boundary as list/beginOperation — raw SQL must never escape the router.
      throw redactPlatformReadError(error);
    }
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
    const authorized = await this.resolveAuthorized(userId, { platformAgentId });
    const target = authorized[0];
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

  private createOperationHandle = (
    snapshot: PlatformAgentOperationSnapshot,
    distribution?: Distribution,
  ): PlatformAgentOperationHandle =>
    Object.freeze<PlatformAgentOperationHandle>({
      distribution,
      getSnapshot: () => snapshot,
      platformAgentId: snapshot.platformAgentId,
    });

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
    try {
      const snapshot = await this.captureOperationSnapshot(userId, platformAgentId);
      if (!snapshot) return null;
      return this.createOperationHandle(snapshot);
    } catch (error) {
      // Redact any unexpected driver / SQL failure so entitlement resolution never leaks internals.
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Capture the exact effective Agent assigned to a stable system role (PR-051 default inbox).
   * This uses the same authorized set as {@link beginOperation}, but ignores the list-only hidden
   * preference: hiding a catalog tile must never turn the fixed inbox into an unmanaged bypass.
   * A genuinely absent assigned/published system Agent returns null; resolver/DB failures throw.
   */
  beginSystemOperation = async (
    userId: string,
    systemKey: NonNullable<AuthorizedAgent['systemKey']>,
  ): Promise<PlatformAgentOperationHandle | null> => {
    try {
      const authorized = await this.resolveAuthorized(userId, { systemKey });
      const target = authorized[0];
      if (!target) return null;
      const snapshot = deepFreeze<PlatformAgentOperationSnapshot>(
        structuredClone({
          checksum: target.checksum,
          config: target.config,
          platformAgentId: target.platformAgentId,
          versionId: target.versionId,
        }),
      );
      return this.createOperationHandle(snapshot, target.distribution);
    } catch (error) {
      throw redactPlatformReadError(error);
    }
  };

  /**
   * Snapshot-free entitlement re-check (M10 PR-049 · RR3-1). Returns whether `userId` is CURRENTLY
   * entitled to `platformAgentId`, using the exact same owner-scoped assignment + managed-policy +
   * flag resolution as {@link beginOperation}, but WITHOUT capturing the latest version snapshot.
   *
   * A resume uses this to verify LIVE entitlement (so a revoked / no-longer-assigned user fails
   * closed) while still replaying its OWN exact pinned version via `materializeFromPin` — entitlement
   * is checked against current state, the running version stays pinned. Never resolves "latest".
   */
  isEntitled = async (userId: string, platformAgentId: string): Promise<boolean> => {
    try {
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      return authorized.length > 0;
    } catch (error) {
      throw redactPlatformReadError(error);
    }
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
    try {
      const authorized = await this.resolveAuthorized(userId, { platformAgentId });
      const target = authorized[0];
      if (!target) throw new PlatformAgentNotFoundError();
      // A mandatory Agent can never be hidden by an ordinary user (ROOT-01). Reject the write
      // instead of silently accepting a no-op, so the boundary is explicit. Un-hiding (hidden=false)
      // stays a harmless no-op for mandatory.
      if (hidden && target.distribution === 'mandatory') {
        throw new PlatformAgentInvalidInputError();
      }
      const written = await new PlatformAgentCatalogRepository(this.db).setMaterializationHidden({
        hidden,
        platformAgentId: target.platformAgentId,
        platformAgentVersionChecksum: target.checksum,
        platformAgentVersionId: target.versionId,
        userId,
      });
      if (!written) throw new PlatformAgentNotFoundError();
    } catch (error) {
      // NotFound passes through; any unexpected driver / SQL failure is redacted (REWORK-5).
      throw redactPlatformReadError(error);
    }
  };
}
