import type { LobeChatDatabase, Transaction } from '@/database/type';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import type {
  AdminSecretRotationCancelInput,
  AdminSecretRotationRetryInput,
  AdminSecretRotationStartInput,
} from '../../contracts/adminSecretRotation';
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
  ) {}

  private coordinator = (): PlatformSecretRewrapCoordinator => this.coordinatorFactory();

  private auditedMutation = async <T>(params: {
    action: string;
    actorUserId: string;
    reason: string;
    requestId: string;
    run: (coordinator: PlatformSecretRewrapCoordinator, tx: Transaction) => Promise<T>;
    summarize: (result: T) => Record<string, unknown>;
    targetId: string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(async (tx) => {
        const result = await params.run(this.coordinator(), tx);
        await this.auditFactory(tx).append({
          action: params.action,
          actorUserId: params.actorUserId,
          afterDiff: params.summarize(result),
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
      requestId: input.requestId,
      run: (coordinator, tx) => coordinator.cancel(tx, input),
      summarize: summarizeJob,
      targetId: input.jobId,
    });

  get = async (jobId: string) => {
    const job = await this.coordinator().get(this.db, jobId);
    if (!job) throw new PlatformSecretRewrapNotFoundError();
    return job;
  };

  list = async (input: { cursor?: string; limit?: number } = {}) =>
    this.coordinator().list(this.db, input);

  retry = async (actorUserId: string, input: AdminSecretRotationRetryInput) =>
    this.auditedMutation({
      action: 'admin.security.secretRotation.retry',
      actorUserId,
      reason: input.reason,
      requestId: input.requestId,
      run: (coordinator, tx) => coordinator.retry(tx, input),
      summarize: summarizeJob,
      targetId: input.jobId,
    });

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
