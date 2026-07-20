import { createHash } from 'node:crypto';

import { defineRequestState } from '@better-auth/core/context';
import type {
  EnterpriseOidcFailureCategory,
  EnterpriseOidcLoginStage,
} from '@lobechat/observability-otel/modules/enterprise-platform';

import { observeEnterprisePlatformEvent } from '@/server/enterprise/observability';

// Better Auth OAuth state expires after ten minutes. Keep the hashed attempt marker slightly
// longer so the first callback arriving just after expiry still records state_invalid once.
const OBSERVATION_TTL_MS = 15 * 60 * 1000;
const OBSERVATION_KEY_PREFIX = 'platform-oidc-observation';

interface VerificationValue {
  expiresAt: Date;
  identifier: string;
  value: string;
}

export interface PlatformOidcObservationStore {
  consumeVerificationValue: (identifier: string) => Promise<VerificationValue | null>;
  createVerificationValue: (value: VerificationValue) => Promise<VerificationValue>;
  findVerificationValue: (identifier: string) => Promise<VerificationValue | null>;
}

type PlatformOidcObservationFlow = 'link' | 'sign_in';

interface PlatformOidcObservationMarker {
  flow: PlatformOidcObservationFlow;
}

interface PlatformOidcLoginAttempt {
  failureCategory?: EnterpriseOidcFailureCategory;
  pendingIdentifier?: string;
  stage: EnterpriseOidcLoginStage;
  store?: PlatformOidcObservationStore;
  terminal: boolean;
}

const attemptState = defineRequestState<PlatformOidcLoginAttempt | null>(() => null);
const getAttempt = async (): Promise<PlatformOidcLoginAttempt | null> => {
  try {
    return await attemptState.get();
  } catch {
    // Provider adapter methods are also callable directly in tests and plugin initialization.
    return null;
  }
};

const markerValue = (flow: PlatformOidcObservationFlow): string => JSON.stringify({ flow });

const parseMarker = (value: string): PlatformOidcObservationMarker | null => {
  try {
    const parsed = JSON.parse(value) as { flow?: unknown };
    return parsed.flow === 'link' || parsed.flow === 'sign_in' ? { flow: parsed.flow } : null;
  } catch {
    return null;
  }
};

const stateDigest = (state: string): string => createHash('sha256').update(state).digest('hex');

const observationIdentifiers = (state: string) => {
  const digest = stateDigest(state);
  return {
    known: `${OBSERVATION_KEY_PREFIX}:known:${digest}`,
    pending: `${OBSERVATION_KEY_PREFIX}:pending:${digest}`,
  };
};

const reportObservationFailure = (): void => {
  console.error('[platform-oidc-observation] shared terminal state unavailable');
};

const createMarker = async (
  store: PlatformOidcObservationStore,
  identifier: string,
  flow: PlatformOidcObservationFlow,
): Promise<void> => {
  await store.createVerificationValue({
    expiresAt: new Date(Date.now() + OBSERVATION_TTL_MS),
    identifier,
    value: markerValue(flow),
  });
};

export const registerPlatformOidcFlow = async (
  store: PlatformOidcObservationStore,
  state: string,
  flow: PlatformOidcObservationFlow,
): Promise<void> => {
  const identifiers = observationIdentifiers(state);
  try {
    await createMarker(store, identifiers.known, flow);
    if (flow === 'sign_in') await createMarker(store, identifiers.pending, flow);
  } catch {
    // Metrics must never make an authorization URL fail after Better Auth persisted its state.
    reportObservationFailure();
  }
};

export const enterPlatformOidcCallbackObservation = async (
  store: PlatformOidcObservationStore,
  state: string | null,
): Promise<void> => {
  if (!state) {
    await attemptState.set({
      failureCategory: 'state_invalid',
      stage: 'state_validation',
      terminal: false,
    });
    return;
  }
  const identifiers = observationIdentifiers(state);
  try {
    const marker = await store.findVerificationValue(identifiers.known);
    const parsedMarker = marker && parseMarker(marker.value);
    if (!parsedMarker) {
      // Never persist attacker-controlled random state. It has no durable attempt to deduplicate.
      await attemptState.set({
        failureCategory: 'state_invalid',
        stage: 'state_validation',
        terminal: false,
      });
      return;
    }
    if (parsedMarker?.flow === 'link') return;
    const pending = await store.findVerificationValue(identifiers.pending);
    if (!pending || parseMarker(pending.value)?.flow !== parsedMarker?.flow) return;
    await attemptState.set({
      failureCategory: 'state_invalid',
      pendingIdentifier: identifiers.pending,
      stage: 'state_validation',
      store,
      terminal: false,
    });
  } catch {
    reportObservationFailure();
  }
};

export const markPlatformOidcLoginStage = (
  stage: EnterpriseOidcLoginStage,
  failureCategory?: EnterpriseOidcFailureCategory,
): Promise<void> =>
  getAttempt().then((attempt) => {
    if (!attempt || attempt.terminal) return;
    attempt.stage = stage;
    attempt.failureCategory = failureCategory;
  });

const observeTerminal = async (
  outcome: 'failure' | 'success',
  fallbackFailureCategory?: EnterpriseOidcFailureCategory,
): Promise<void> => {
  const attempt = await getAttempt();
  if (!attempt || attempt.terminal) return;
  attempt.terminal = true;
  try {
    if (attempt.store && attempt.pendingIdentifier) {
      const claimed = await attempt.store.consumeVerificationValue(attempt.pendingIdentifier);
      if (!claimed) return;
      const claimedMarker = parseMarker(claimed.value);
      if (claimedMarker?.flow !== 'sign_in') return;
    }
    if (outcome === 'success') {
      observeEnterprisePlatformEvent({
        outcome: 'success',
        stage: 'authenticated',
        type: 'oidc_login',
      });
      return;
    }
    observeEnterprisePlatformEvent({
      failureCategory: attempt.failureCategory ?? fallbackFailureCategory ?? 'unexpected',
      outcome: 'failure',
      stage: attempt.stage,
      type: 'oidc_login',
    });
  } catch {
    reportObservationFailure();
  }
};

export const observePlatformOidcLoginFailure = async (
  fallbackFailureCategory?: EnterpriseOidcFailureCategory,
): Promise<void> => observeTerminal('failure', fallbackFailureCategory);

export const observePlatformOidcLoginSuccess = async (): Promise<void> =>
  observeTerminal('success');
