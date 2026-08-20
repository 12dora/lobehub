import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { INBOX_SESSION_ID } from '@lobechat/const';
import { decodePlatformAgentListId } from '@lobechat/types';
import { and, eq, isNull } from 'drizzle-orm';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { AgentModel } from '@/database/models/agent';
// Deep import (not the `models/platform` barrel): this predicate sits on list / runtime
// hot paths, and the barrel pulls in ~30 unrelated platform models — several of which
// build SQL fragments at module scope.
import {
  type ManagedResourcePolicySnapshot,
  PlatformManagedResourcePolicyModel,
} from '@/database/models/platform/managedResourcePolicy';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import { agents, chatGroupsAgents } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { throwEnterpriseError } from '../../guards/enterpriseErrors';

/**
 * Short memo so list / runtime hot paths do not read the policy table on every
 * request. Deliberately tiny: it directly delays "enforcement ended ⇒ the user
 * gets their own agents back", and the read it saves is a single five-row SELECT.
 *
 * The publishing instance drops the memo synchronously (see
 * `resetPlatformAgentTakeoverCache`, called from `ManagedResourcePolicyService.publish`),
 * so this TTL only bounds staleness on OTHER instances of a multi-instance deployment.
 */
export const PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS = 2_000;

const BUILTIN_SLUGS = new Set<string>(Object.values(BUILTIN_AGENT_SLUGS));

export const HETEROGENEOUS_PROVIDER_TYPES = [
  'amp',
  'claude-code',
  'codex',
  'hermes',
  'openclaw',
  'opencode',
] as const;

const HETERO_TYPE_SET = new Set<string>(HETEROGENEOUS_PROVIDER_TYPES);

let takeoverEpoch = 0;
let takeoverMemo = new WeakMap<object, { epoch: number; expiresAt: number; value: boolean }>();

/**
 * True only when the administrator has PUBLISHED 平台托管 for agents.
 *
 * This — not catalog membership, and not `publicCapabilities.agents` (true for
 * historical `ui-only` as well) — is what authorizes the platform agent catalog
 * to **replace** the user's own agent list and to refuse running leftover
 * user-owned local agents.
 *
 * Reads the PUBLISHED policy directly rather than `effectiveModes`: the latter
 * downgrades `enforced → unmanaged` when catalog readiness is false, which would
 * make enforcement silently lapse and hand users back their own agents during a
 * catalog outage. Enforcement can only be published while ready
 * (`prepareLockedPublish`), so honouring the published policy is fail-closed.
 *
 * Feature-off → `false` without reading the table. A `getSnapshot()` failure
 * propagates (fail closed) instead of degrading to "not managed".
 *
 * A generation/epoch is captured before the snapshot await so a publish that
 * resets the memo while this read is in flight cannot write the stale answer
 * into the new map.
 */
export const isPlatformAgentTakeoverActive = async (
  db: LobeChatDatabase,
  flags: EnterpriseFeatureFlags = parseEnterpriseFeatureFlags(process.env),
  now: () => number = Date.now,
  readSnapshot: (database: LobeChatDatabase) => Promise<ManagedResourcePolicySnapshot> = (
    database,
  ) => new PlatformManagedResourcePolicyModel(database).getSnapshot(),
): Promise<boolean> => {
  if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return false;

  const at = now();
  const epoch = takeoverEpoch;
  const cached = takeoverMemo.get(db as object);
  if (cached && cached.epoch === epoch && cached.expiresAt > at) return cached.value;

  const snapshot = await readSnapshot(db);
  const item = snapshot.published.agents;
  const value =
    snapshot.status === 'published' && item.managed && item.enforcementMode === 'enforced';

  if (epoch === takeoverEpoch) {
    takeoverMemo.set(db as object, {
      epoch,
      expiresAt: at + PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS,
      value,
    });
  }
  return value;
};

/**
 * Drop the memo so the very next read observes the freshly published policy.
 *
 * Called from `ManagedResourcePolicyService.publish` AFTER the publish transaction
 * commits (never from `afterMaterialization`, which runs inside the transaction —
 * repopulating the memo there would cache a pre-commit answer).
 *
 * In-process only: other instances converge within `PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS`.
 */
export const resetPlatformAgentTakeoverCache = (): void => {
  takeoverEpoch += 1;
  takeoverMemo = new WeakMap();
};

export const resetPlatformAgentTakeoverCacheForTest = resetPlatformAgentTakeoverCache;

const isBuiltinAgentIdentity = (value: string | null | undefined): boolean =>
  typeof value === 'string' && (value === INBOX_SESSION_ID || BUILTIN_SLUGS.has(value));

const workspaceOwner = (workspaceId: string | undefined) =>
  workspaceId ? eq(chatGroupsAgents.workspaceId, workspaceId) : isNull(chatGroupsAgents.workspaceId);

const agentsWorkspaceOwner = (workspaceId: string | undefined) =>
  workspaceId ? eq(agents.workspaceId, workspaceId) : isNull(agents.workspaceId);

export const isValidatedHeterogeneousAgent = (agencyConfig: unknown): boolean => {
  if (!agencyConfig || typeof agencyConfig !== 'object') return false;
  const provider = (agencyConfig as { heterogeneousProvider?: { type?: unknown } })
    .heterogeneousProvider;
  return typeof provider?.type === 'string' && HETERO_TYPE_SET.has(provider.type);
};

export const isGroupSupervisorAgent = async (params: {
  agentId: string;
  db: LobeChatDatabase;
  userId: string;
  workspaceId?: string;
}): Promise<boolean> => {
  const rows = await params.db
    .select({ agentId: chatGroupsAgents.agentId })
    .from(chatGroupsAgents)
    .where(
      and(
        eq(chatGroupsAgents.agentId, params.agentId),
        eq(chatGroupsAgents.role, 'supervisor'),
        eq(chatGroupsAgents.userId, params.userId),
        workspaceOwner(params.workspaceId),
      ),
    )
    .limit(1);
  return rows.length > 0;
};

/**
 * Local agent ids still reachable under takeover: inbox, materialized platform
 * clones, group supervisors, and validated heterogeneous agents.
 *
 * `null` means takeover is off — callers must not filter.
 */
export const resolveTakeoverVisibleLocalAgentIds = async (params: {
  db: LobeChatDatabase;
  userId: string;
  workspaceId?: string;
}): Promise<Set<string> | null> => {
  if (!(await isPlatformAgentTakeoverActive(params.db))) return null;

  const agentModel = new AgentModel(params.db, params.userId, params.workspaceId);
  const [inbox, materialized, supervisorRows, agentRows] = await Promise.all([
    agentModel.getBuiltinAgent(INBOX_SESSION_ID),
    new PlatformAgentCatalogRepository(params.db).listMaterializedAgentIds(params.userId),
    params.db
      .select({ agentId: chatGroupsAgents.agentId })
      .from(chatGroupsAgents)
      .where(
        and(
          eq(chatGroupsAgents.role, 'supervisor'),
          eq(chatGroupsAgents.userId, params.userId),
          workspaceOwner(params.workspaceId),
        ),
      ),
    params.db
      .select({ agencyConfig: agents.agencyConfig, id: agents.id })
      .from(agents)
      .where(and(eq(agents.userId, params.userId), agentsWorkspaceOwner(params.workspaceId))),
  ]);

  const ids = new Set<string>(materialized);
  if (inbox?.id) ids.add(inbox.id);
  for (const row of supervisorRows) ids.add(row.agentId);
  for (const row of agentRows) {
    if (isValidatedHeterogeneousAgent(row.agencyConfig)) ids.add(row.id);
  }
  return ids;
};

const throwManagedByPlatform = (): never =>
  throwEnterpriseError({
    code: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    details: { resource: 'agents' },
    httpCode: 'FORBIDDEN',
    message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
  });

/**
 * Under agent takeover, refuse to read/run a user-owned local agent that is
 * neither the builtin inbox (or another builtin slug), nor an encoded platform
 * list id, nor a materialized platform clone, nor a group supervisor, nor a
 * validated heterogeneous agent.
 *
 * Inverse of `assertAgentNotPlatformManaged` (that one blocks edits to platform
 * clones). Builtin identity is the Agent **row** slug (`AgentItem.slug`), never
 * `LobeAgentConfig` — pass `slug` when the caller already loaded the row;
 * otherwise this looks it up. Group supervisors are identified from
 * `chat_groups_agents.role`, not slug. Heterogeneous agents from validated
 * `agencyConfig.heterogeneousProvider.type`.
 *
 * No-op when takeover is not active.
 */
export const assertLocalAgentReadableUnderTakeover = async (params: {
  db: LobeChatDatabase;
  identifier: string;
  slug?: string | null;
  userId: string;
  workspaceId?: string;
}): Promise<void> => {
  if (!(await isPlatformAgentTakeoverActive(params.db))) return;
  if (isBuiltinAgentIdentity(params.identifier) || isBuiltinAgentIdentity(params.slug)) return;
  if (decodePlatformAgentListId(params.identifier)) return;

  const row = await new AgentModel(params.db, params.userId, params.workspaceId).getAgentConfigById(
    params.identifier,
  );
  if (isBuiltinAgentIdentity(row?.slug) || isValidatedHeterogeneousAgent(row?.agencyConfig)) {
    return;
  }

  if (
    await isGroupSupervisorAgent({
      agentId: params.identifier,
      db: params.db,
      userId: params.userId,
      workspaceId: params.workspaceId,
    })
  ) {
    return;
  }

  const platformAgentId = await new PlatformAgentCatalogRepository(
    params.db,
  ).getPlatformAgentIdByMaterializedAgentId(params.userId, params.identifier);
  if (platformAgentId) return;

  throwManagedByPlatform();
};

/** Deny a topic/thread whose parent local agent is hidden under takeover. */
export const assertTopicAgentVisibleUnderTakeover = async (params: {
  agentId: string | null | undefined;
  db: LobeChatDatabase;
  userId: string;
  workspaceId?: string;
}): Promise<void> => {
  if (!params.agentId) return;
  await assertLocalAgentReadableUnderTakeover({
    db: params.db,
    identifier: params.agentId,
    userId: params.userId,
    workspaceId: params.workspaceId,
  });
};
