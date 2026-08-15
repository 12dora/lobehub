import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
// Deep import (not the `models/platform` barrel): this predicate sits on the chat / runtime
// hot path, and the barrel pulls in ~30 unrelated platform models — several of which build
// SQL fragments at module scope.
import { PlatformManagedResourcePolicyModel } from '@/database/models/platform/managedResourcePolicy';
import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';

/**
 * Short memo so hot paths (chat, model list, runtime state) do not read the policy table on
 * every request. Deliberately tiny: it directly delays "enforcement ended ⇒ the user gets
 * their own configuration back", and the read it saves is a single five-row SELECT.
 *
 * The publishing instance drops the memo synchronously (see `resetPlatformAiTakeoverCache`,
 * called from `ManagedResourcePolicyService.publish`), so this TTL only bounds staleness on
 * OTHER instances of a multi-instance deployment.
 */
export const PLATFORM_AI_TAKEOVER_MEMO_TTL_MS = 2_000;

let takeoverMemo = new WeakMap<object, { expiresAt: number; value: boolean }>();

/**
 * True only when the administrator has PUBLISHED 平台托管 for AI providers.
 *
 * This — not catalog membership — is what authorizes the platform AI catalog to override a
 * user's own provider configuration (runtime state, settings model list, chat credentials,
 * the published-model allowlist). Connecting a shared account or publishing a provider has
 * zero user-visible effect until this predicate is true.
 *
 * Reads the PUBLISHED policy directly rather than `effectiveModes`: the latter downgrades
 * `enforced → unmanaged` when catalog readiness is false, which would make enforcement
 * silently lapse and hand users back their own credentials during a catalog outage.
 * Enforcement can only be published while ready (`prepareLockedPublish`), so honouring the
 * published policy is fail-closed. `resolvePublishedManagedResourcePolicies` mirrors this for
 * `aiProviders`/`aiModels` so the client blocks the UI exactly when the server takes over.
 *
 * Never calls `resolveManagedResourceReadiness()` — for `aiProviders` that probe loads the
 * whole catalog and decrypts every provider secret, which must not sit on the chat hot path.
 *
 * A `getSnapshot()` failure propagates (fail closed) instead of degrading to "not managed".
 */
export const isPlatformAiTakeoverActive = async (
  db: LobeChatDatabase,
  flags: EnterpriseFeatureFlags = parseEnterpriseFeatureFlags(process.env),
  now: () => number = Date.now,
): Promise<boolean> => {
  if (!flags.ENABLE_PLATFORM_MANAGED_AI) return false;

  const at = now();
  const cached = takeoverMemo.get(db as object);
  if (cached && cached.expiresAt > at) return cached.value;

  const snapshot = await new PlatformManagedResourcePolicyModel(db).getSnapshot();
  const item = snapshot.published.aiProviders;
  const value =
    snapshot.status === 'published' && item.managed && item.enforcementMode === 'enforced';

  takeoverMemo.set(db as object, { expiresAt: at + PLATFORM_AI_TAKEOVER_MEMO_TTL_MS, value });
  return value;
};

/**
 * Drop the memo so the very next read observes the freshly published policy.
 *
 * Called from `ManagedResourcePolicyService.publish` AFTER the publish transaction commits
 * (never from `afterMaterialization`, which runs inside the transaction — repopulating the
 * memo there would cache a pre-commit answer).
 *
 * In-process only: the platform's existing invalidation channel
 * (`PlatformConfigInvalidationPublisher`) is a pull-based Redis version-key bump with no
 * subscriber side, so there is nothing to ride for a push-based cross-instance reset. Other
 * instances converge within `PLATFORM_AI_TAKEOVER_MEMO_TTL_MS`.
 */
export const resetPlatformAiTakeoverCache = (): void => {
  takeoverMemo = new WeakMap();
};

export const resetPlatformAiTakeoverCacheForTest = resetPlatformAiTakeoverCache;
