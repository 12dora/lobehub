import { BUILTIN_AGENT_SLUGS } from '@lobechat/builtin-agents';
import { INBOX_SESSION_ID } from '@lobechat/const';
import { decodePlatformAgentListId } from '@lobechat/types';

import { MANAGED_ERROR_CODES } from '@/const/platform/errorCodes';
import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import { AgentModel } from '@/database/models/agent';
// Deep import (not the `models/platform` barrel): this predicate sits on list / runtime
// hot paths, and the barrel pulls in ~30 unrelated platform models — several of which
// build SQL fragments at module scope.
import { PlatformManagedResourcePolicyModel } from '@/database/models/platform/managedResourcePolicy';
import { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
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

let takeoverMemo = new WeakMap<object, { expiresAt: number; value: boolean }>();

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
 */
export const isPlatformAgentTakeoverActive = async (
  db: LobeChatDatabase,
  flags: EnterpriseFeatureFlags = parseEnterpriseFeatureFlags(process.env),
  now: () => number = Date.now,
): Promise<boolean> => {
  if (!flags.ENABLE_PLATFORM_MANAGED_AGENTS) return false;

  const at = now();
  const cached = takeoverMemo.get(db as object);
  if (cached && cached.expiresAt > at) return cached.value;

  const snapshot = await new PlatformManagedResourcePolicyModel(db).getSnapshot();
  const item = snapshot.published.agents;
  const value =
    snapshot.status === 'published' && item.managed && item.enforcementMode === 'enforced';

  takeoverMemo.set(db as object, { expiresAt: at + PLATFORM_AGENT_TAKEOVER_MEMO_TTL_MS, value });
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
  takeoverMemo = new WeakMap();
};

export const resetPlatformAgentTakeoverCacheForTest = resetPlatformAgentTakeoverCache;

const isBuiltinAgentIdentity = (value: string | null | undefined): boolean =>
  typeof value === 'string' && (value === INBOX_SESSION_ID || BUILTIN_SLUGS.has(value));

/**
 * Under agent takeover, refuse to read/run a user-owned local agent that is
 * neither the builtin inbox (or another builtin slug), nor an encoded platform
 * list id, nor a materialized platform clone.
 *
 * Inverse of `assertAgentNotPlatformManaged` (that one blocks edits to platform
 * clones). Builtin identity is the Agent **row** slug (`AgentItem.slug`), never
 * `LobeAgentConfig` — pass `slug` when the caller already loaded the row;
 * otherwise this looks it up.
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
  if (isBuiltinAgentIdentity(params.identifier)) return;
  if (decodePlatformAgentListId(params.identifier)) return;

  const slug =
    params.slug !== undefined
      ? params.slug
      : (
          await new AgentModel(params.db, params.userId, params.workspaceId).getAgentConfigById(
            params.identifier,
          )
        )?.slug;
  if (isBuiltinAgentIdentity(slug)) return;

  const platformAgentId = await new PlatformAgentCatalogRepository(
    params.db,
  ).getPlatformAgentIdByMaterializedAgentId(params.userId, params.identifier);
  if (platformAgentId) return;

  throwEnterpriseError({
    code: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
    details: { resource: 'agents' },
    httpCode: 'FORBIDDEN',
    message: MANAGED_ERROR_CODES.RESOURCE_MANAGED_BY_PLATFORM,
  });
};
