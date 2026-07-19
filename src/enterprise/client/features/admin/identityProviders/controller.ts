export const isIdentityProviderTestTerminal = (status: string): boolean =>
  status !== 'pending' && status !== 'processing';

export const parseIdentityProviderJsonObject = (
  raw: string,
): { valid: false } | { valid: true; value: Record<string, unknown> } => {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
    return { valid: true, value: value as Record<string, unknown> };
  } catch {
    return { valid: false };
  }
};

export class IdentityProviderTestPopupBlockedError extends Error {
  constructor() {
    super('IDENTITY_PROVIDER_TEST_POPUP_BLOCKED');
    this.name = 'IdentityProviderTestPopupBlockedError';
  }
}

export const openIdentityProviderTestPopup = async <Result extends { authorizationUrl: string }>(
  start: () => Promise<Result>,
  openWindow: typeof window.open = window.open.bind(window),
): Promise<Result> => {
  const popup = openWindow('about:blank', 'oidc-provider-test', 'width=520,height=720');
  if (!popup) throw new IdentityProviderTestPopupBlockedError();
  try {
    const result = await start();
    popup.location.assign(result.authorizationUrl);
    return result;
  } catch (error) {
    if (!popup.closed) popup.close();
    throw error;
  }
};

export type IdentityProviderRestartPhase = 'accepted' | 'activated' | 'failed' | 'idle';

export const IDENTITY_PROVIDER_RESTART_TIMEOUT_MS = 120_000;

export interface AcceptedIdentityProviderRestart {
  acceptedAt: number;
  deadlineAt: number;
  requestId: string;
  targetIdentityRevision: string;
}

export const acceptIdentityProviderRestart = (
  prepared: { expectedIdentityRevision: string; requestId: string },
  response: {
    accepted: boolean;
    acceptedAt: Date;
    expectedIdentityRevision: string;
    requestId: string;
  },
): AcceptedIdentityProviderRestart | null => {
  const acceptedAt = response.acceptedAt.getTime();
  if (
    !response.accepted ||
    !Number.isFinite(acceptedAt) ||
    response.requestId !== prepared.requestId ||
    response.expectedIdentityRevision !== prepared.expectedIdentityRevision
  ) {
    return null;
  }
  return {
    acceptedAt,
    deadlineAt: acceptedAt + IDENTITY_PROVIDER_RESTART_TIMEOUT_MS,
    requestId: response.requestId,
    targetIdentityRevision: response.expectedIdentityRevision,
  };
};

export const resolveIdentityProviderRestartPhase = (input: {
  attempt: AcceptedIdentityProviderRestart | null;
  error: unknown;
  now: number;
  phase: IdentityProviderRestartPhase;
  status?: {
    active: { allFreshInstancesActive: boolean };
    pendingRestart: boolean;
    restart: { supported: boolean };
    targetIdentityRevision: string | null;
  };
}): IdentityProviderRestartPhase => {
  if (input.phase !== 'accepted') return input.phase;
  if (!input.attempt || input.now >= input.attempt.deadlineAt) return 'failed';
  if (!input.status) return 'accepted';
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
  if (!input.nextRevision || input.currentRevision === input.nextRevision) return 'unchanged';
  return input.preserveDraft ? 'preserve' : 'hydrate';
};
