import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { PlatformSecretRotationCandidate } from '@/database/repositories/platformSecretRotation';
import { PlatformSecretRotationRepository } from '@/database/repositories/platformSecretRotation';
import type { Transaction } from '@/database/type';
import type { PlatformSecretService } from '@/server/enterprise/security/secret';
import { PlatformSecretError } from '@/server/enterprise/security/secret';

import type { PlatformSecretRewrapFailureCategory } from './contracts';
import { PlatformSecretRewrapProviderError } from './errors';

export type CandidateOutcome =
  | { category: PlatformSecretRewrapFailureCategory; kind: 'failed' }
  | { kind: 'no_op' }
  | { kind: 'rotated' };

export type PreparedCandidate =
  | CandidateOutcome
  | {
      ciphertext: string;
      kind: 'prepared';
    };

interface CandidateCasLifecycle {
  beforeCandidateCas?: (params: {
    candidate: PlatformSecretRotationCandidate;
    db: Transaction;
  }) => Promise<void>;
}

export const assertActiveTarget = async (secrets: PlatformSecretService, targetKeyId: string) => {
  if (secrets.keyProviderId !== 'vault') {
    throw new PlatformSecretRewrapProviderError('vault_required');
  }
  let activeKeyId: string;
  try {
    activeKeyId = await secrets.getActiveKeyId();
  } catch {
    throw new PlatformSecretRewrapProviderError('vault_unavailable');
  }
  if (activeKeyId !== targetKeyId) {
    throw new PlatformSecretRewrapProviderError('active_key_changed');
  }
};

const classifyCryptoFailure = async (
  secrets: PlatformSecretService,
  targetKeyId: string,
  error: unknown,
): Promise<PlatformSecretRewrapFailureCategory> => {
  if (
    error instanceof PlatformSecretError &&
    error.code === PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT
  ) {
    return 'invalid_ciphertext';
  }
  await assertActiveTarget(secrets, targetKeyId);
  if (error instanceof PlatformSecretError && error.details?.reason === 'unknown-key-id') {
    return 'historical_key_unavailable';
  }
  return 'ciphertext_not_readable';
};

const isAlreadyTarget = (
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  targetKeyId: string,
) =>
  candidate.storedKeyId === targetKeyId && secrets.peekKeyId(candidate.ciphertext) === targetKeyId;

/** Remote-only phase. No database transaction or lock is held here. */
export const prepareCandidate = async (
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  targetKeyId: string,
): Promise<PreparedCandidate> => {
  try {
    if (isAlreadyTarget(secrets, candidate, targetKeyId)) return { kind: 'no_op' };
  } catch (error) {
    return { category: await classifyCryptoFailure(secrets, targetKeyId, error), kind: 'failed' };
  }

  let ciphertext: string;
  try {
    ciphertext = await secrets.rotateToKeyId(candidate.ciphertext, targetKeyId);
  } catch (error) {
    return { category: await classifyCryptoFailure(secrets, targetKeyId, error), kind: 'failed' };
  }

  return { ciphertext, kind: 'prepared' };
};

/** Short transactional phase: exact CAS plus conflict classification. */
export const commitPreparedCandidate = async (
  tx: Transaction,
  secrets: PlatformSecretService,
  candidate: PlatformSecretRotationCandidate,
  prepared: PreparedCandidate,
  targetKeyId: string,
  lifecycle?: CandidateCasLifecycle,
): Promise<CandidateOutcome> => {
  if (prepared.kind !== 'prepared') return prepared;
  await lifecycle?.beforeCandidateCas?.({ candidate, db: tx });
  const repository = PlatformSecretRotationRepository.forTransaction(tx);
  const updated = await repository.rotateExact({
    candidate,
    ciphertext: prepared.ciphertext,
    targetKeyId,
  });
  if (updated.updated) return { kind: 'rotated' };

  const current = await repository.getById(candidate.domain, candidate.id);
  if (!current) {
    // Row left the active/unexpired inventory between scan and CAS (revoked secret,
    // expired upload, hard delete). Not a permanent concurrent_change deadlock —
    // treat as resolved no-op so the job can finish and historical keys can retire.
    return { kind: 'no_op' };
  }
  try {
    if (isAlreadyTarget(secrets, current, targetKeyId)) return { kind: 'no_op' };
  } catch {
    // A concurrent malformed replacement is a CAS conflict, not this worker's crypto failure.
  }
  return { category: 'concurrent_change', kind: 'failed' };
};
