/**
 * Repository-pinned production trust policy.
 *
 * CRITICAL: No production private keys are shipped. The checked-in production
 * policy has zero trusted public keys, so production overall pass is impossible
 * until a reviewed public key/issuer is added via an explicit policy change.
 *
 * Callers cannot replace this policy via CLI path or environment variable.
 */
import type { EvidenceGateId } from '../constants';
import { REQUIRED_EVIDENCE_GATES } from '../constants';

export const TRUST_POLICY_SCHEMA_VERSION = 1 as const;

export type TrustEnvironment = 'ci-harness' | 'local-harness' | 'production' | 'staging';

export interface TrustedPublicKey {
  environments: readonly TrustEnvironment[];
  fingerprint: string;
  issuer: string;
  keyId: string;
  publicKeyBase64: string;
  /** When true, key must not verify production environment. */
  revoked: boolean;
}

export interface TrustPolicy {
  /** Hard switch: false means production overall pass is always unavailable. */
  productionPassEnabled: boolean;
  schemaVersion: typeof TRUST_POLICY_SCHEMA_VERSION;
  trustedKeys: readonly TrustedPublicKey[];
}

/**
 * Immutable production policy embedded in the repository.
 * Empty trustedKeys + productionPassEnabled=false → production pass impossible.
 */
export const PRODUCTION_TRUST_POLICY: TrustPolicy = Object.freeze({
  productionPassEnabled: false,
  schemaVersion: TRUST_POLICY_SCHEMA_VERSION,
  trustedKeys: Object.freeze([]) as readonly TrustedPublicKey[],
});

/** Gates that production mode requires signed provenance for. */
export const PRODUCTION_SIGNED_GATES: readonly EvidenceGateId[] = REQUIRED_EVIDENCE_GATES;

export const findTrustedKey = (
  policy: TrustPolicy,
  input: { fingerprint: string; keyId: string; issuer: string },
): TrustedPublicKey | undefined =>
  policy.trustedKeys.find(
    (key) =>
      key.keyId === input.keyId &&
      key.issuer === input.issuer &&
      key.fingerprint === input.fingerprint &&
      !key.revoked,
  );
