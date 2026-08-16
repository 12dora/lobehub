export type IdentityProviderRestartPhase = 'accepted' | 'activated' | 'failed' | 'idle';

export const IDENTITY_PROVIDER_RESTART_TIMEOUT_MS = 120_000;

export interface AcceptedIdentityProviderRestart {
  acceptedAt: number;
  convergenceDeadlineAt: number;
  deadlineAtMonotonic: number;
  requestId: string;
  targetIdentityRevision: string;
}

export const acceptIdentityProviderRestart = (
  prepared: { expectedIdentityRevision: string; requestId: string },
  response: {
    accepted: boolean;
    acceptedAt: Date;
    convergenceDeadlineAt: Date;
    expectedIdentityRevision: string;
    remainingMs: number;
    requestId: string;
    serverNow: Date;
  },
  receivedAtMonotonic: number,
): AcceptedIdentityProviderRestart | null => {
  const acceptedAt = response.acceptedAt.getTime();
  const convergenceDeadlineAt = response.convergenceDeadlineAt.getTime();
  const serverNow = response.serverNow.getTime();
  const expectedRemainingMs = Math.min(
    IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
    Math.max(0, convergenceDeadlineAt - serverNow),
  );
  if (
    !response.accepted ||
    !Number.isFinite(acceptedAt) ||
    !Number.isFinite(convergenceDeadlineAt) ||
    !Number.isFinite(receivedAtMonotonic) ||
    !Number.isFinite(serverNow) ||
    !Number.isInteger(response.remainingMs) ||
    response.remainingMs !== expectedRemainingMs ||
    convergenceDeadlineAt !== acceptedAt + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS ||
    response.requestId !== prepared.requestId ||
    response.expectedIdentityRevision !== prepared.expectedIdentityRevision
  ) {
    return null;
  }
  return {
    acceptedAt,
    convergenceDeadlineAt,
    deadlineAtMonotonic: receivedAtMonotonic + response.remainingMs,
    requestId: response.requestId,
    targetIdentityRevision: response.expectedIdentityRevision,
  };
};

export const resolveIdentityProviderRestartPhase = (input: {
  attempt: AcceptedIdentityProviderRestart | null;
  error: unknown;
  nowMonotonic: number;
  phase: IdentityProviderRestartPhase;
  status?: {
    active: { allFreshInstancesActive: boolean };
    pendingRestart: boolean;
    restart: { supported: boolean };
    restartRequest?: {
      requestId: string;
      resultCategory: string | null;
      status: 'accepted' | 'failed' | 'signaled';
    } | null;
    /** Bounded recent requests so concurrent restarts cannot hide a failed poll target. */
    restartRequests?: Array<{
      requestId: string;
      resultCategory: string | null;
      status: 'accepted' | 'failed' | 'signaled';
    }>;
    targetIdentityRevision: string | null;
  };
}): IdentityProviderRestartPhase => {
  if (input.phase !== 'accepted') return input.phase;
  if (!input.attempt || input.nowMonotonic >= input.attempt.deadlineAtMonotonic) return 'failed';
  // Terminal polling/transport errors must not leave the UI stuck until the deadline.
  if (input.error) return 'failed';
  if (!input.status) return 'accepted';
  // Known terminal request failure (e.g. schedule failure) must not wait for the deadline.
  // Prefer exact request match from the bounded map when concurrent restarts exist.
  const restartRequests = input.status.restartRequests ?? [];
  const restartRequest =
    restartRequests.find((request) => request.requestId === input.attempt!.requestId) ??
    (input.status.restartRequest?.requestId === input.attempt.requestId
      ? input.status.restartRequest
      : null);
  if (restartRequest && restartRequest.status === 'failed') {
    return 'failed';
  }
  if (
    input.status.active.allFreshInstancesActive &&
    !input.status.pendingRestart &&
    input.status.targetIdentityRevision === input.attempt.targetIdentityRevision
  ) {
    return 'activated';
  }
  if (
    input.status.targetIdentityRevision &&
    input.status.targetIdentityRevision !== input.attempt.targetIdentityRevision
  ) {
    return 'failed';
  }
  if (input.status.pendingRestart && !input.status.restart.supported) return 'failed';
  return 'accepted';
};

export const resolveIdentityProviderRevisionRefresh = (input: {
  currentRevision?: number;
  nextRevision?: number;
  preserveDraft: boolean;
}): 'hydrate' | 'preserve' | 'unchanged' => {
  // Revision 0 is a real CAS value (create without a secret). Do not treat it as missing.
  if (input.nextRevision === undefined || input.currentRevision === input.nextRevision) {
    return 'unchanged';
  }
  return input.preserveDraft ? 'preserve' : 'hydrate';
};

/**
 * Canonical provider row for wizard CAS (edit mode).
 * Prefer the list cache hit when its revision is at least as new as the mutation-retained
 * canonical row; otherwise keep the mutation response so page-scoped lists (first 100 /
 * current page) cannot leave a stale revision for test/publish after save.
 */
export const resolveIdentityProviderWizardLiveProvider = <
  T extends { id: string; revision: number },
>(input: {
  canonicalProvider?: T;
  isEdit: boolean;
  listHit?: T;
  propProvider?: T;
}): T | undefined => {
  if (!input.isEdit) return input.canonicalProvider ?? input.propProvider;
  if (
    input.listHit &&
    (!input.canonicalProvider || input.listHit.revision >= input.canonicalProvider.revision)
  ) {
    return input.listHit;
  }
  return input.canonicalProvider ?? input.propProvider;
};
