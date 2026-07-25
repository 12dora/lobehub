/**
 * Policy / authorization effective-agent resolver.
 * Ordering helpers: `./effectiveResolverOrder`. SQL: `./effectiveAgentQuery`.
 * Hidden preference writes: `./effectiveAgentPreference`.
 */
import type { z } from 'zod';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import {
  type ManagedResourcePolicySnapshot,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform';
import { checksumPayload } from '@/database/models/platform/checksum';
import {
  PlatformAgentCatalogRepository,
  type PlatformAgentEffectiveInput,
} from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';

import type { platformAgentEffectiveListOutputSchema } from '../../contracts/platformAgents';
import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { setPlatformAgentHiddenPreference } from './effectiveAgentPreference';
import { queryEffectiveInputsPage } from './effectiveAgentQuery';
import {
  compareEffectiveInputPriority,
  cursorFromEffectiveInputRow,
  isEffectiveInputAfterCursor,
  PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
  PLATFORM_AGENT_EFFECTIVE_LIST_MAX,
  type PlatformAgentEffectiveInputCursor,
  type PlatformAgentEffectiveInputsFilter,
  type PlatformAgentOperationHandle,
  type PlatformAgentOperationSnapshot,
} from './effectiveResolverOrder';
import { PlatformAgentNotFoundError, redactPlatformReadError } from './errors';

export * from './effectiveAgentPreference';
export * from './effectiveAgentQuery';
export * from './effectiveResolverOrder';

type EffectiveList = z.infer<typeof platformAgentEffectiveListOutputSchema>;
type EffectiveAgent = EffectiveList['agents'][number];
type Distribution = EffectiveAgent['distribution'];

type EffectiveInputFilter = PlatformAgentEffectiveInputsFilter;
type EffectiveInputRow = PlatformAgentEffectiveInput;

/** Authorized (assignment-resolved) Agent before per-user hidden filtering. */
interface AuthorizedAgent {
  agentKey: string;
  checksum: string;
  config: PlatformAgentEffectiveInput['version']['config'];
  distribution: Distribution;
  platformAgentId: string;
  systemKey: 'default-inbox' | null;
  version: string;
  versionId: string;
}

type ResolverRepository = {
  listEffectiveInputs: (
    userId: string,
    filter?: PlatformAgentEffectiveInputsFilter,
  ) => Promise<PlatformAgentEffectiveInput[]>;
  listHiddenPlatformAgentIds: (
    userId: string,
  ) => Promise<Awaited<ReturnType<PlatformAgentCatalogRepository['listHiddenPlatformAgentIds']>>>;
};

interface PlatformAgentEffectiveResolverOptions {
  flags?: EnterpriseFeatureFlags;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  queryEffectiveInputsPage?: (
    db: LobeChatDatabase,
    userId: string,
    filter?: PlatformAgentEffectiveInputsFilter,
  ) => Promise<PlatformAgentEffectiveInput[]>;
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

/**
 * First-winner de-dupe for a single targeted resolution (not the full-list pager).
 * Full-list paging dedupes in SQL ({@link queryVisibleWinnerPage}).
 */
interface WinnerDedupe {
  agents: Set<string>;
  systemKeys: Set<string>;
}

const createWinnerDedupe = (): WinnerDedupe => ({
  agents: new Set<string>(),
  systemKeys: new Set<string>(),
});

/** User-safe effective platform Agent projection. Feature/policy-off paths never query Agent rows. */
export class PlatformAgentEffectiveResolver {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly options: PlatformAgentEffectiveResolverOptions = {},
  ) {}

  /** Production full-list keyset SQL (or test override of the same contract). */
  private runFullListQuery = (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<EffectiveInputRow[]> =>
    (this.options.queryEffectiveInputsPage ?? queryEffectiveInputsPage)(this.db, userId, filter);

  /**
   * One page of effective inputs.
   *
   * Full-list path (no platformAgentId / systemKey) ALWAYS uses {@link queryEffectiveInputsPage}
   * so keyset cursor advancement cannot be silently dropped by
   * `PlatformAgentCatalogRepository.listEffectiveInputs` (still cursor-less — targeted only).
   * Targeted single-agent / system-key lookups may use an injected repository.
   */
  private listEffectiveInputPage = async (
    userId: string,
    filter?: EffectiveInputFilter,
  ): Promise<EffectiveInputRow[]> => {
    const isFullList = !filter?.platformAgentId && !filter?.systemKey;
    if (isFullList) {
      return this.runFullListQuery(userId, filter);
    }
    if (this.options.repository) {
      return this.options.repository.listEffectiveInputs(userId, filter);
    }
    return this.runFullListQuery(userId, filter);
  };

  /**
   * Project assignment rows into de-duplicated authorized Agents in stable winner order.
   * Does not apply the wire cap or hidden filtering — callers decide those policy layers.
   * Optional shared de-dupe allows keyset pages to continue first-winner state across pages.
   */
  private projectAuthorizedRows = (
    rows: EffectiveInputRow[],
    dedupe: WinnerDedupe = createWinnerDedupe(),
  ): AuthorizedAgent[] => {
    const ordered = [...rows].sort(compareEffectiveInputPriority);
    const authorized: AuthorizedAgent[] = [];
    for (const row of ordered) {
      if (dedupe.agents.has(row.agent.id)) continue;
      if (row.agent.systemKey && dedupe.systemKeys.has(row.agent.systemKey)) continue;
      dedupe.agents.add(row.agent.id);
      if (row.agent.systemKey) dedupe.systemKeys.add(row.agent.systemKey);
      authorized.push({
        agentKey: row.agent.agentKey,
        checksum: row.version.checksum,
        config: row.version.config,
        distribution: row.assignment.mode as Distribution,
        platformAgentId: row.agent.id,
        systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
        version: row.version.version,
        versionId: row.version.id,
      });
    }
    return authorized;
  };

  /**
   * Authorization-only resolution: the assignment-scoped, de-duplicated Agents a user is
   * entitled to (server-authoritative role/scope/expiry filtering lives in the repository
   * query). Does NOT apply per-user hidden filtering — that is a list-view concern applied
   * by `getEffectiveList`, not an authorization boundary.
   *
   * Pass `filter` for single-agent / system-key lookups so the repository never scans the full
   * assignment catalog. Full-list callers pass a SQL `limit` (and optional keyset `cursor`) so the
   * repository never loads an unbounded assignment set.
   */
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

    const rows = await this.listEffectiveInputPage(userId, filter);
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

      // Full-list SQL already applies owner-scoped hidden filtering after first-winner dedup.
      // Pages return unique visible winners; accumulate only up to the wire max — no seen sets.
      const agents: EffectiveAgent[] = [];
      let cursor: PlatformAgentEffectiveInputCursor | undefined;

      for (;;) {
        const rows = await this.listEffectiveInputPage(userId, {
          cursor,
          limit: PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH,
        });

        // Non-progress guard: page must strictly advance past the cursor (avoids infinite loop
        // if SQL keyset wiring regresses). Production {@link queryVisibleWinnerPage} always advances.
        if (cursor && rows.length > 0 && !isEffectiveInputAfterCursor(rows[0]!, cursor)) {
          break;
        }

        for (const row of rows) {
          if (agents.length >= PLATFORM_AGENT_EFFECTIVE_LIST_MAX) break;
          agents.push(
            projectEffective({
              agentKey: row.agent.agentKey,
              checksum: row.version.checksum,
              config: row.version.config,
              distribution: row.assignment.mode as Distribution,
              platformAgentId: row.agent.id,
              systemKey: row.agent.systemKey === 'default-inbox' ? 'default-inbox' : null,
              version: row.version.version,
              versionId: row.version.id,
            }),
          );
        }

        const sourceExhausted = rows.length < PLATFORM_AGENT_EFFECTIVE_INPUT_BATCH;
        const listFull = agents.length >= PLATFORM_AGENT_EFFECTIVE_LIST_MAX;
        if (sourceExhausted || listFull || rows.length === 0) break;

        cursor = cursorFromEffectiveInputRow(rows.at(-1)!);
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
        const hidden = this.options.repository
          ? await this.options.repository.listHiddenPlatformAgentIds(userId)
          : await new PlatformAgentCatalogRepository(this.db).listHiddenPlatformAgentIds(userId);
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
      await setPlatformAgentHiddenPreference(this.db, {
        hidden,
        target: {
          checksum: target.checksum,
          distribution: target.distribution,
          platformAgentId: target.platformAgentId,
          versionId: target.versionId,
        },
        userId,
      });
    } catch (error) {
      throw redactPlatformReadError(error);
    }
  };
}
