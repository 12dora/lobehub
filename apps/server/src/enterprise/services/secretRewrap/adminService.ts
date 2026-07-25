import type { LobeChatDatabase, Transaction } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import type {
  AdminSecretRotationCancelInput,
  AdminSecretRotationRestartInput,
  AdminSecretRotationRetryInput,
  AdminSecretRotationStartInput,
} from '../../contracts/adminSecretRotation';
import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { PlatformSecretRewrapCoordinator } from './coordinator';
import {
  PlatformSecretRewrapConflictError,
  PlatformSecretRewrapInvalidError,
  PlatformSecretRewrapNotFoundError,
  PlatformSecretRewrapProviderError,
} from './errors';

type CoordinatorFactory = () => PlatformSecretRewrapCoordinator;
type AuditFactory = (db: LobeChatDatabase | Transaction) => Pick<PlatformAuditService, 'append'>;

/**
 * Vault-backed coordinator for crypto-bearing mutations (start / enqueue).
 * get / list / cancel / retry / restart are DB-only and must not require a
 * valid Vault config so recovery remains possible during key-provider incidents.
 */
const createCoordinatorFromEnvironment = (): PlatformSecretRewrapCoordinator => {
  let secrets: PlatformSecretService | null;
  try {
    secrets = PlatformSecretService.tryFromEnv();
  } catch {
    throw new PlatformSecretRewrapProviderError('vault_unavailable');
  }
  if (!secrets || secrets.keyProviderId !== 'vault') {
    throw new PlatformSecretRewrapProviderError('vault_required');
  }
  return new PlatformSecretRewrapCoordinator(secrets);
};

/** Unconfigured coordinator for database-only recovery operations. */
const createDbOnlyCoordinator = (): PlatformSecretRewrapCoordinator =>
  new PlatformSecretRewrapCoordinator();

const failureCategory = (error: unknown): string => {
  if (error instanceof PlatformSecretRewrapConflictError) return 'rotation_conflict';
  if (error instanceof PlatformSecretRewrapInvalidError) return 'invalid_input';
  if (error instanceof PlatformSecretRewrapNotFoundError) return 'not_found';
  if (error instanceof PlatformSecretRewrapProviderError) return 'key_provider_unavailable';
  return 'rotation_mutation_failed';
};

const summarizeJob = (job: Awaited<ReturnType<PlatformSecretRewrapCoordinator['get']>>) => {
  if (!job) throw new PlatformSecretRewrapNotFoundError();
  return {
    externalArtifactGate: job.counts.externalArtifactGate,
    historicalKeyRemovalReady: false,
    jobId: job.jobId,
    revision: job.revision,
    status: job.status,
    targetKeyId: job.targetKeyId,
  };
};

/**
 * Audited API boundary for the internal secret-rewrap coordinator.
 * Successful business writes and audit appends share one transaction. Failure auditing starts
 * only after rollback and carries a stable category instead of the thrown message or input body.
 */
export class PlatformSecretRotationAdminService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly coordinatorFactory: CoordinatorFactory = createCoordinatorFromEnvironment,
    private readonly auditFactory: AuditFactory = (auditDb) => new PlatformAuditService(auditDb),
    /**
     * DB-only ops (get / list / cancel / retry / restart). Defaults to an
     * unconfigured coordinator so missing Vault does not block recovery.
     * Tests may inject the same mock.
     */
    private readonly dbOnlyCoordinatorFactory: CoordinatorFactory = createDbOnlyCoordinator,
  ) {}

  /** Crypto-bearing ops: validates Vault via the injected factory. */
  private coordinator = (): PlatformSecretRewrapCoordinator => this.coordinatorFactory();

  /** Recovery / inspection ops: never require Vault configuration. */
  private dbOnlyCoordinator = (): PlatformSecretRewrapCoordinator =>
    this.dbOnlyCoordinatorFactory();

  private auditedMutation = async <T>(params: {
    action: AuditAction;
    actorUserId: string;
    reason: string;
    /** When false, use the DB-only coordinator (no Vault requirement). Default true. */
    requireVault?: boolean;
    requestId: string;
    run: (coordinator: PlatformSecretRewrapCoordinator, tx: Transaction) => Promise<T>;
    /** Optional pre-mutation snapshot for audits that clear terminal diagnostics (e.g. restart). */
    summarizeBefore?: (result: T) => Record<string, unknown> | null;
    summarize: (result: T) => Record<string, unknown>;
    targetId: string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(async (tx) => {
        const coordinator =
          params.requireVault === false ? this.dbOnlyCoordinator() : this.coordinator();
        const result = await params.run(coordinator, tx);
        await this.auditFactory(tx).append({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: params.summarize(result),
          beforeDiff: params.summarizeBefore?.(result) ?? undefined,
          reason: params.reason,
          requestId: params.requestId,
          result: 'success',
          targetId: params.targetId,
          targetType: 'secret_rotation',
        });
        return result;
      });
    } catch (error) {
      try {
        await this.auditFactory(this.db).append({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: { error: failureCategory(error) },
          reason: params.reason,
          requestId: params.requestId,
          result: 'failure',
          targetId: params.targetId,
          targetType: 'secret_rotation',
        });
      } catch (auditError) {
        console.error('[admin.security.secretRotation] failure audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };

  cancel = async (actorUserId: string, input: AdminSecretRotationCancelInput) =>
    this.auditedMutation({
      action: 'admin.security.secretRotation.cancel',
      actorUserId,
      reason: input.reason,
      requireVault: false,
      requestId: input.requestId,
      run: (coordinator, tx) => coordinator.cancel(tx, input),
      summarize: summarizeJob,
      targetId: input.jobId,
    });

  get = async (jobId: string) => {
    const job = await this.dbOnlyCoordinator().get(this.db, jobId);
    if (!job) throw new PlatformSecretRewrapNotFoundError();
    return job;
  };

  list = async (input: { cursor?: string; limit?: number } = {}) =>
    this.dbOnlyCoordinator().list(this.db, input);

  /**
   * Re-queue a failed job from its failure ledger. Pure DB — no Vault.
   * Allows recovery while the key provider is down.
   */
  retry = async (actorUserId: string, input: AdminSecretRotationRetryInput) =>
    this.auditedMutation({
      action: 'admin.security.secretRotation.retry',
      actorUserId,
      reason: input.reason,
      requireVault: false,
      requestId: input.requestId,
      run: (coordinator, tx) => coordinator.retry(tx, input),
      summarize: summarizeJob,
      targetId: input.jobId,
    });

  /**
   * Restart a cancelled/dead job as a new generation. Pure DB — no Vault.
   * Distinct from failed-ledger retry; cancelled/dead jobs have no ledger.
   * Terminal status / error / counts are captured in the success audit beforeDiff
   * so the cleared dead-job diagnostics remain auditable.
   */
  restart = async (actorUserId: string, input: AdminSecretRotationRestartInput) => {
    const outcome = await this.auditedMutation({
      action: 'admin.security.secretRotation.restart',
      actorUserId,
      reason: input.reason,
      requireVault: false,
      requestId: input.requestId,
      run: (coordinator, tx) => coordinator.restart(tx, input),
      summarize: (result) => summarizeJob(result.job),
      summarizeBefore: (result) => result.terminalBefore,
      targetId: input.jobId,
    });
    return outcome.job;
  };

  start = async (actorUserId: string, input: AdminSecretRotationStartInput) =>
    this.auditedMutation({
      action: 'admin.security.secretRotation.start',
      actorUserId,
      reason: input.reason,
      requestId: input.requestId,
      run: (coordinator, tx) =>
        coordinator.enqueue(tx, {
          reason: input.reason,
          requestId: input.requestId,
          requestedBy: actorUserId,
          targetKeyId: input.targetKeyId,
        }),
      summarize: summarizeJob,
      targetId: input.targetKeyId,
    });
}
