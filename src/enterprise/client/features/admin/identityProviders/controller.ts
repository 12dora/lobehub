import {
  PLATFORM_IDENTITY_PROVIDER_TEMPLATES,
  type PlatformIdentityProviderTemplate,
  type PlatformIdentityProviderType,
} from '@lobechat/types';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import type { AdminResourceStatus } from '../primitives/statusBadge.utils';

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

/** Deploy-time codes that should surface as a single setup guidance empty state. */
const SETUP_GUIDANCE_CODES = new Set<string>([
  PLATFORM_ERROR_CODES.PLATFORM_FEATURE_DISABLED,
  PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
]);

const SETUP_GUIDANCE_MESSAGE_MARKERS = [
  'PLATFORM_FEATURE_DISABLED',
  'PLATFORM_SECRET_REQUIRED',
  'PLATFORM_APP_URL_INVALID',
] as const;

const extractErrorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return '';
  const parts: string[] = [];
  if ('message' in error && typeof (error as { message?: unknown }).message === 'string') {
    parts.push((error as { message: string }).message);
  }
  const data = (error as { data?: { errorData?: { message?: unknown } } }).data;
  if (typeof data?.errorData?.message === 'string') parts.push(data.errorData.message);
  const cause = (error as { cause?: { data?: { message?: unknown } } }).cause;
  if (typeof cause?.data?.message === 'string') parts.push(cause.data.message);
  return parts.join(' ');
};

/**
 * True when list/load failed because Database OIDC is disabled or deploy config is incomplete.
 * Does not treat PLATFORM_INVALID_INPUT (generic validation) as setup guidance.
 */
export const isIdentityProviderSetupGuidanceError = (error: unknown): boolean => {
  if (!error) return false;
  const mapped = mapEnterpriseError(error);
  if (mapped && SETUP_GUIDANCE_CODES.has(mapped.code)) return true;
  // Never promote generic invalid-input to the deploy guidance empty state.
  if (mapped?.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT) return false;
  const message = extractErrorMessage(error);
  return SETUP_GUIDANCE_MESSAGE_MARKERS.some((marker) => message.includes(marker));
};

/** Map provider lifecycle status onto StatusBadge semantic tokens. */
export const toIdentityProviderStatusBadge = (
  status: string | null | undefined,
): AdminResourceStatus => {
  switch (status) {
    case 'draft': {
      return 'draft';
    }
    case 'published': {
      return 'published';
    }
    case 'pending_restart': {
      return 'pending';
    }
    case 'active': {
      return 'active';
    }
    case 'error': {
      return 'error';
    }
    case 'disabled': {
      return 'disabled';
    }
    case 'archived': {
      return 'archived';
    }
    default: {
      return 'unknown';
    }
  }
};

export type IdentityProviderCreateTemplateId = PlatformIdentityProviderType;

export interface IdentityProviderCreateDraftSeed {
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderTemplate['claimMapping'];
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
}

export const createIdentityProviderDraftFromTemplate = (
  type: IdentityProviderCreateTemplateId,
): IdentityProviderCreateDraftSeed => {
  const template = PLATFORM_IDENTITY_PROVIDER_TEMPLATES[type];
  return {
    buttonLabel: template.buttonLabel,
    claimMapping: structuredClone(template.claimMapping),
    scopes: [...template.scopes],
    type: template.type,
    usePkce: true,
  };
};

/** Authentik issuer field placeholder used in the discovery step. */
export const AUTHENTIK_ISSUER_PLACEHOLDER = 'https://auth.jiefakj.com/application/o/<slug>/';

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
    targetIdentityRevision: string | null;
  };
}): IdentityProviderRestartPhase => {
  if (input.phase !== 'accepted') return input.phase;
  if (!input.attempt || input.nowMonotonic >= input.attempt.deadlineAtMonotonic) return 'failed';
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
