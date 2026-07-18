import { TRPCError } from '@trpc/server';

import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';
import { trpc } from '@/libs/trpc/lambda/init';

import { parseEnterpriseFeatureFlags } from '../featureFlags';

const MANAGED_AGENT_MUTATION_FORBIDDEN = {
  code: 'FORBIDDEN',
  message: 'This agent is managed by your organization and cannot be modified here.',
} as const;

/**
 * Reject an ordinary Agent mutation (update / remove / pin / group) when the target local Agent id
 * is actually a materialization of a platform Agent for THIS user (M10 PR-049 · ROOT-02).
 *
 * A materialized local row is only an FK / persistence-compatible attribution identity — its
 * managed fields (systemRole, model, provider, …) are NOT user-editable and the runtime config is
 * always taken from the pinned operation snapshot, never the row. Without this guard a user who
 * learns their materialized local id could edit or delete a managed Agent through the ordinary
 * endpoints (a delete would otherwise hit a raw FK restrict error). The lookup is:
 *
 * - flag-gated: with `ENABLE_PLATFORM_MANAGED_AGENTS` off it is a no-op, so ordinary local Agents
 *   are completely unaffected and there is zero platform access on the legacy path;
 * - owner-scoped: `getPlatformAgentIdByMaterializedAgentId` filters by the trusted `userId`, so a
 *   foreign / non-materialized id resolves to null and passes through untouched.
 */
export const assertAgentNotPlatformManaged = async (params: {
  agentId: string;
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  await assertAgentsNotPlatformManaged({
    agentIds: [params.agentId],
    db: params.db,
    userId: params.userId,
  });
};

/**
 * Array form of {@link assertAgentNotPlatformManaged} (M10 PR-049 · RR2-4). Rejects the whole
 * mutation when ANY of the given local Agent ids is a materialization of a platform Agent for THIS
 * user — so a batch write (e.g. `addAgentsToGroup` / `removeAgentsFromGroup`) is validated per item
 * and cannot smuggle a managed Agent through inside an array. Same flag-gating (no-op when
 * `ENABLE_PLATFORM_MANAGED_AGENTS` is off → zero platform access on the legacy path) and same
 * owner-scoped reverse lookup as the single form. Ids are de-duplicated; the check runs before any
 * write, so a rejected batch performs ZERO writes.
 */
export const assertAgentsNotPlatformManaged = async (params: {
  agentIds: string[];
  db: LobeChatDatabase;
  userId: string;
}): Promise<void> => {
  if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return;
  const uniqueIds = [...new Set(params.agentIds)].filter((id) => id.length > 0);
  if (uniqueIds.length === 0) return;
  const repository = new PlatformAgentCatalogRepository(params.db);
  for (const agentId of uniqueIds) {
    const platformAgentId = await repository.getPlatformAgentIdByMaterializedAgentId(
      params.userId,
      agentId,
    );
    if (platformAgentId) {
      throw new TRPCError(MANAGED_AGENT_MUTATION_FORBIDDEN);
    }
  }
};

/** Extracts the agent id(s) a mutation targets from its raw tRPC input. */
export type ManagedLocalAgentIdPicker = (input: unknown) => Array<string | null | undefined>;

/** The common shapes: `{ agentId }`, `{ agentIds: [] }`, and `{ id }` (agent-router alias). */
const asRecord = (input: unknown): Record<string, unknown> =>
  input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

/** `{ agentId }` picker — the dominant single-agent write shape. */
export const pickAgentId: ManagedLocalAgentIdPicker = (input) => [
  asRecord(input).agentId as string,
];

/** `{ id }` picker — the agent router's alias for the target agent (publish / visibility / pin). */
export const pickId: ManagedLocalAgentIdPicker = (input) => [asRecord(input).id as string];

/** `{ agentIds: string[] }` picker — batch group membership writes. */
export const pickAgentIds: ManagedLocalAgentIdPicker = (input) => {
  const value = asRecord(input).agentIds;
  return Array.isArray(value) ? (value as string[]) : [];
};

/** `{ agentId?, sourceAgentId?, targetAgentId? }` picker — covers every agent-document write. */
export const pickDocumentAgentIds: ManagedLocalAgentIdPicker = (input) => {
  const record = asRecord(input);
  return [record.agentId as string, record.sourceAgentId as string, record.targetAgentId as string];
};

/**
 * tRPC middleware that refuses an ordinary agent-scoped mutation when its target local Agent is a
 * materialized platform Agent (M10 PR-049 · RR2-4). This is the single, uniform guard applied to
 * EVERY agent-scoped write — it centralizes the flag gate, the owner-scoped reverse lookup, and
 * per-item iteration so no write path is left unguarded and array inputs can't bypass it.
 *
 * - Runs BEFORE the handler, so a rejected mutation performs zero writes / side effects.
 * - Flag off (`ENABLE_PLATFORM_MANAGED_AGENTS`) → no-op: ordinary local Agents are completely
 *   unaffected and the legacy path has zero platform access.
 * - Owner-scoped: a foreign / non-materialized id resolves to null and passes through untouched.
 */
export const withManagedLocalAgentGuard = (pick: ManagedLocalAgentIdPicker) =>
  trpc.middleware(async ({ ctx, getRawInput, next }) => {
    if (!parseEnterpriseFeatureFlags(process.env).ENABLE_PLATFORM_MANAGED_AGENTS) return next();
    const db = (ctx as { serverDB?: LobeChatDatabase }).serverDB;
    if (!db) throw new Error('withManagedLocalAgentGuard requires serverDatabase middleware');
    const userId = (ctx as { userId?: string }).userId;
    // Auth middleware already guarantees a userId on these procedures; without one we can't
    // owner-scope the lookup, so defer to the auth layer rather than fail open on a global lookup.
    if (typeof userId !== 'string' || userId.length === 0) return next();
    const agentIds = pick(await getRawInput()).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
    await assertAgentsNotPlatformManaged({ agentIds, db, userId });
    return next();
  });
