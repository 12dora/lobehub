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

export const resolveIdentityProviderRestartPhase = (input: {
  error: unknown;
  phase: IdentityProviderRestartPhase;
  status?: {
    active: { allFreshInstancesActive: boolean };
    pendingRestart: boolean;
    restart: { supported: boolean };
    targetIdentityRevision: string | null;
  };
}): IdentityProviderRestartPhase => {
  if (input.phase !== 'accepted') return input.phase;
  if (input.error && !input.status) return 'failed';
  if (!input.status) return 'accepted';
  if (
    input.status.active.allFreshInstancesActive &&
    !input.status.pendingRestart &&
    input.status.targetIdentityRevision
  ) {
    return 'activated';
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
