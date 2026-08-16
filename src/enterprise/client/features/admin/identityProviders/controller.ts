import {
  DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH,
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  PLATFORM_IDENTITY_PROVIDER_TEMPLATES,
  type PlatformIdentityProviderAllowedCorp,
  type PlatformIdentityProviderTemplate,
  type PlatformIdentityProviderType,
} from '@lobechat/types';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { mapEnterpriseError } from '@/enterprise/client/errors/mapEnterpriseError';

import type { AdminResourceStatus } from '../primitives/statusBadge.utils';

export const isIdentityProviderTestTerminal = (status: string): boolean =>
  status !== 'pending' && status !== 'processing';

export const isIdentityProviderDraftWorkflowReady = (
  provider: { status: string } | null | undefined,
): boolean => provider?.status === 'draft';

export type IdentityProviderWorkflowErrorKind =
  'corp-allowlist-required' | 'draft-required' | 'generic' | 'test-required';

export const classifyIdentityProviderWorkflowError = (
  error: unknown,
): IdentityProviderWorkflowErrorKind => {
  const mapped = mapEnterpriseError(error);
  const reason =
    mapped?.details && typeof mapped.details === 'object'
      ? (mapped.details as { reason?: unknown }).reason
      : undefined;
  if (reason === 'identity_provider_draft_required') return 'draft-required';
  if (reason === 'identity_provider_test_required') return 'test-required';
  if (reason === 'identity_provider_corp_allowlist_required') return 'corp-allowlist-required';
  return 'generic';
};

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

/**
 * Published-history signal for draft heads.
 * Never conflate lookup failure/loading with "never published" — those are `unknown`.
 * After publish→edit/secret-clear the mutable head is draft with activationRevision=null,
 * but a prior published revision may still be live and must remain tombstoneable.
 */
export type PublishedHistorySignal = 'has-history' | 'no-history' | 'unknown';

export const resolvePublishedHistorySignal = (
  byId: Record<string, PublishedHistorySignal>,
  id: string,
): PublishedHistorySignal => byId[id] ?? 'unknown';

/**
 * Disable (tombstone) when the provider is live, or a draft that has (or may have)
 * published history. On `unknown` (loading/lookup error), fail safe toward revocation.
 */
export const isIdentityProviderDisableable = (
  provider: { status: string },
  publishedHistory: PublishedHistorySignal,
): boolean => {
  if (
    provider.status === 'active' ||
    provider.status === 'pending_restart' ||
    provider.status === 'published' ||
    provider.status === 'error'
  ) {
    return true;
  }
  if (provider.status === 'draft') {
    return publishedHistory === 'has-history' || publishedHistory === 'unknown';
  }
  return false;
};

/**
 * Hard-delete only when the draft is confirmed never-published.
 * `unknown` must not offer Delete — the backend rejects delete for providers with history.
 */
export const isIdentityProviderDeletable = (
  provider: { status: string },
  publishedHistory: PublishedHistorySignal,
): boolean => provider.status === 'draft' && publishedHistory === 'no-history';

export type IdentityProviderCreateTemplateId = PlatformIdentityProviderType;

export interface IdentityProviderCreateDraftSeed {
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderTemplate['claimMapping'];
  icon: string | null;
  /** Pre-filled for kinds whose issuer is fixed by the protocol (e.g. DingTalk). */
  issuer: string;
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
    icon: template.icon,
    issuer: type === 'dingtalk' ? DINGTALK_IDENTITY_PROVIDER_ISSUER : '',
    scopes: [...template.scopes],
    type: template.type,
    usePkce: true,
  };
};

/**
 * Kinds whose endpoints, claim mapping and issuer are fixed by the protocol. Their wizard
 * hides the discovery and claims steps and offers an organisation pin instead.
 */
export const isFixedProtocolIdentityProviderType = (type: PlatformIdentityProviderType): boolean =>
  type === 'dingtalk';

/**
 * Notes are held raw while the administrator types (so a trailing space before the next word is
 * not eaten on every keystroke) and normalised here, on the way to the API.
 */
export const serializeIdentityProviderAllowedCorps = (
  entries: readonly PlatformIdentityProviderAllowedCorp[],
): PlatformIdentityProviderAllowedCorp[] =>
  entries.map(({ label, ...entry }) => {
    const trimmed = label?.trim();
    return trimmed ? { ...entry, label: trimmed } : entry;
  });

/** Keep generated labels inside the persisted `label` limit — `nick` may be far longer. */
export const boundIdentityProviderCorpLabel = (label: string): string =>
  label.length <= DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH
    ? label
    : `${label.slice(0, DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH - 1)}\u2026`;

/**
 * Safe-login / organisation-capture failures reported by the server as a stable error code.
 * Mapped to admin-facing copy so a DingTalk misconfiguration (wrong AppSecret, redirect URL not
 * registered, `corpid` scope missing) reads as an instruction instead of an opaque code.
 */
// A Map, not an object: codes arrive from the server, and an object lookup would
// resolve inherited members such as `constructor` to a non-key value.
const IDENTITY_PROVIDER_TEST_ERROR_KEYS = new Map<string, string>(
  Object.entries({
    OIDC_TEST_ACCESS_TOKEN_REQUIRED: 'identityProviders.test.errors.accessTokenRequired',
    OIDC_TEST_AUTHORIZATION_FAILED: 'identityProviders.test.errors.authorizationFailed',
    OIDC_TEST_CALLBACK_ORIGIN_INVALID: 'identityProviders.test.errors.callbackOriginInvalid',
    OIDC_TEST_CLAIM_VALIDATION_FAILED: 'identityProviders.test.errors.claimValidationFailed',
    OIDC_TEST_CONFIG_INCOMPLETE: 'identityProviders.test.errors.configIncomplete',
    OIDC_TEST_CORP_ID_MISSING: 'identityProviders.test.errors.corpIdMissing',
    OIDC_TEST_DISCOVERY_INVALID: 'identityProviders.test.errors.discoveryInvalid',
    OIDC_TEST_DRAFT_REQUIRED: 'identityProviders.workflow.draftRequired',
    OIDC_TEST_ID_TOKEN_INVALID: 'identityProviders.test.errors.idTokenInvalid',
    OIDC_TEST_ISSUER_INVALID: 'identityProviders.test.errors.issuerInvalid',
    OIDC_TEST_NONCE_INVALID: 'identityProviders.test.errors.idTokenInvalid',
    OIDC_TEST_PROVIDER_CHANGED: 'identityProviders.test.errors.providerChanged',
    OIDC_TEST_REMOTE_INVALID: 'identityProviders.test.errors.remoteInvalid',
    OIDC_TEST_REPLAYED: 'identityProviders.test.errors.replayed',
    OIDC_TEST_RESPONSE_ISSUER_INVALID: 'identityProviders.test.errors.responseIssuerInvalid',
    OIDC_TEST_SECRET_UNAVAILABLE: 'identityProviders.test.errors.secretUnavailable',
    OIDC_TEST_SUBJECT_MISMATCH: 'identityProviders.test.errors.subjectMismatch',
    OIDC_TEST_USERINFO_REQUIRED: 'identityProviders.test.errors.userinfoRequired',
  }),
);

/** Stable error code embedded anywhere in an error payload (`OIDC_TEST_*`). */
export const extractIdentityProviderTestErrorCode = (value: unknown): string | null => {
  const source =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? JSON.stringify(value)
        : '';
  return /\bOIDC_TEST_[A-Z_]+\b/.exec(source)?.[0] ?? null;
};

/** i18n key describing a failed safe-login / capture attempt. */
export const identityProviderTestErrorKey = (errorCode: string | null | undefined): string =>
  (errorCode ? IDENTITY_PROVIDER_TEST_ERROR_KEYS.get(errorCode) : undefined) ??
  'identityProviders.test.errors.generic';

/** Authentik issuer field placeholder used in the discovery step. */
export const AUTHENTIK_ISSUER_PLACEHOLDER = 'https://auth.example.com/application/o/<slug>/';

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
  if (!input.nextRevision || input.currentRevision === input.nextRevision) return 'unchanged';
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
