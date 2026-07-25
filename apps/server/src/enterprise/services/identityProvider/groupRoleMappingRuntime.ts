/**
 * Crosses the Better Auth getUserInfo → session.create boundary.
 * getUserInfo knows IdP groups but not userId; session.create has userId.
 *
 * Pending mappings are stored as DISTINCT PER-FLOW entries (OAuth state / flow id).
 * Login reconcile prefers the OAuth flow id from better-auth request state
 * (set by parseState before createSession) so concurrent same-provider+same-subject
 * logins never steal each other's mapping. Subject-index newest-take is only the
 * fallback when no flow id is available (subject-only / non-OAuth paths).
 */
import type { LobeChatDatabase } from '@/database/type';

import { applyGroupRoleMappingToUser } from './groupRoleMapping';

type PendingGroupRoleMapping = {
  expiresAt: number;
  groupRoleMapping: Record<string, string>;
  groups: string[];
  providerKey: string;
  /** Monotonic stash time so subject-keyed take prefers the newest concurrent flow. */
  stashedAt: number;
  subject: string;
};

const PENDING_TTL_MS = 10 * 60 * 1000;
/** Hard cap so failed logins across many flows cannot grow process memory without bound. */
const PENDING_MAX_ENTRIES = 10_000;

/** Primary store: unique login flow/state id → pending mapping. */
const pendingByFlowId = new Map<string, PendingGroupRoleMapping>();
/** Subject index for reconcile when only providerKey+subject is known at session create. */
const subjectToFlowIds = new Map<string, Set<string>>();

const subjectKey = (providerKey: string, subject: string) =>
  `${providerKey.toLowerCase()}:${subject}`;

/** Synthetic flow key when stash runs before OAuth state is known (legacy / mapProfile path). */
const subjectOnlyFlowId = (key: string) => `subject-only:${key}`;

const indexFlowUnderSubject = (key: string, flowId: string): void => {
  let set = subjectToFlowIds.get(key);
  if (!set) {
    set = new Set();
    subjectToFlowIds.set(key, set);
  }
  set.add(flowId);
};

const unindexFlow = (key: string, flowId: string): void => {
  const set = subjectToFlowIds.get(key);
  if (!set) return;
  set.delete(flowId);
  if (set.size === 0) subjectToFlowIds.delete(key);
};

const deleteFlowEntry = (flowId: string): PendingGroupRoleMapping | undefined => {
  const pending = pendingByFlowId.get(flowId);
  if (!pending) return undefined;
  pendingByFlowId.delete(flowId);
  unindexFlow(subjectKey(pending.providerKey, pending.subject), flowId);
  return pending;
};

/** Drop expired entries; if still over capacity, evict the soonest-to-expire keys. */
const sweepPendingGroupRoleMappings = (now = Date.now()): void => {
  for (const [flowId, pending] of pendingByFlowId) {
    if (pending.expiresAt < now) deleteFlowEntry(flowId);
  }
  if (pendingByFlowId.size <= PENDING_MAX_ENTRIES) return;
  const ordered = [...pendingByFlowId.entries()].sort(
    (left, right) => left[1].expiresAt - right[1].expiresAt,
  );
  const overflow = pendingByFlowId.size - PENDING_MAX_ENTRIES;
  for (let i = 0; i < overflow; i += 1) {
    const entry = ordered[i];
    if (entry) deleteFlowEntry(entry[0]);
  }
};

export const stashIdentityProviderGroupRoleMapping = (input: {
  /**
   * OAuth `state` (or other per-login flow id). When present, entries are distinct
   * per flow so concurrent same-subject logins cannot overwrite each other.
   */
  flowId?: string;
  groups: string[];
  groupRoleMapping: Record<string, string>;
  providerKey: string;
  subject: string;
}): void => {
  if (Object.keys(input.groupRoleMapping).length === 0) return;
  sweepPendingGroupRoleMappings();
  const key = subjectKey(input.providerKey, input.subject);
  const flowId = input.flowId?.trim() ? input.flowId : subjectOnlyFlowId(key);
  // Replacing the same flow id: drop prior index membership first.
  const previous = pendingByFlowId.get(flowId);
  if (previous) {
    unindexFlow(subjectKey(previous.providerKey, previous.subject), flowId);
  }
  const now = Date.now();
  pendingByFlowId.set(flowId, {
    expiresAt: now + PENDING_TTL_MS,
    groupRoleMapping: input.groupRoleMapping,
    groups: input.groups,
    providerKey: input.providerKey,
    stashedAt: now,
    subject: input.subject,
  });
  indexFlowUnderSubject(key, flowId);
};

/**
 * Consume one pending mapping for login reconcile.
 *
 * Requires `flowId` (OAuth state from the same request) and consumes that exact
 * flow entry only. Password / non-OAuth session creation must never apply IdP
 * claims from an earlier OAuth request — the previous subject-only newest-take
 * fallback re-granted roles after admin demotion within the stash TTL.
 */
export const takeIdentityProviderGroupRoleMapping = (input: {
  /**
   * OAuth `state` for THIS login. Required — concurrent same-provider+same-subject
   * flows cannot steal each other's mapping, and non-OAuth sessions see no stash.
   */
  flowId?: string;
  providerKey: string;
  subject: string;
}): Pick<PendingGroupRoleMapping, 'expiresAt' | 'groupRoleMapping' | 'groups'> | null => {
  sweepPendingGroupRoleMappings();
  const key = subjectKey(input.providerKey, input.subject);

  if (!input.flowId?.trim()) return null;

  const pending = pendingByFlowId.get(input.flowId);
  if (!pending) return null;
  // Refuse to consume a flow that belongs to a different provider/subject.
  if (subjectKey(pending.providerKey, pending.subject) !== key) return null;
  deleteFlowEntry(input.flowId);
  if (pending.expiresAt < Date.now()) return null;
  return {
    expiresAt: pending.expiresAt,
    groupRoleMapping: pending.groupRoleMapping,
    groups: pending.groups,
  };
};

/**
 * Drop the subject-only synthetic entry (no real flow id). Does NOT clear concurrent
 * flow-keyed entries for the same subject — use discardByFlow for terminal OAuth failures.
 */
export const discardIdentityProviderGroupRoleMapping = (input: {
  providerKey: string;
  subject: string;
}): void => {
  const key = subjectKey(input.providerKey, input.subject);
  deleteFlowEntry(subjectOnlyFlowId(key));
};

/**
 * Drop the pending mapping for a single login flow (OAuth state). Never clears
 * other flows for the same provider+subject.
 */
export const discardIdentityProviderGroupRoleMappingByFlow = (input: {
  flowId: string;
  /** When set, ignore bindings that do not belong to this provider. */
  providerKey?: string;
}): void => {
  if (!input.flowId) return;
  const pending = pendingByFlowId.get(input.flowId);
  if (!pending) return;
  if (input.providerKey && pending.providerKey.toLowerCase() !== input.providerKey.toLowerCase()) {
    return;
  }
  deleteFlowEntry(input.flowId);
};

/** Apply stashed mapping for a platform OIDC login (providerKey + subject). Fail-closed. */
export const reconcileIdentityProviderGroupRoles = async (input: {
  db: LobeChatDatabase;
  /**
   * OAuth flow/state id for THIS session create. When set, consumes the exact
   * pending entry for that flow (identity/F9 concurrent-safe).
   */
  flowId?: string;
  providerKey: string;
  subject: string;
  userId: string;
}): Promise<void> => {
  const pending = takeIdentityProviderGroupRoleMapping({
    flowId: input.flowId,
    providerKey: input.providerKey,
    subject: input.subject,
  });
  if (!pending) return;
  // Entry already consumed; re-stash is wrong — failure must not leave a retryable
  // elevated session. Propagate so the login/session path aborts.
  await applyGroupRoleMappingToUser({
    db: input.db,
    groupRoleMapping: pending.groupRoleMapping,
    groups: pending.groups,
    userId: input.userId,
  });
};

export const resetIdentityProviderGroupRoleMappingRuntimeForTest = (): void => {
  pendingByFlowId.clear();
  subjectToFlowIds.clear();
};

/** Test seam: current pending map size after optional sweep. */
export const pendingIdentityProviderGroupRoleMappingSizeForTest = (): number => {
  sweepPendingGroupRoleMappings();
  return pendingByFlowId.size;
};
