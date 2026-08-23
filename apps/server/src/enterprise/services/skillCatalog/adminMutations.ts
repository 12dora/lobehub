import type { PlatformSkillCatalogModel } from '@/database/models/platform';
import { PlatformRevisionConflictError, platformSkillDraftToken } from '@/database/models/platform';
import { PlatformSkillCatalogRepository } from '@/database/repositories/platformSkillCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { SkillCatalogNotFoundError } from './errors';

export const appendSkillCatalogAudit = async (params: {
  action: AuditAction;
  actorUserId: string;
  afterDiff?: Record<string, unknown>;
  db: LobeChatDatabase | Transaction;
  reason?: string | null;
  result: 'failure' | 'success';
  targetId: string;
}) => {
  await new PlatformAuditService(params.db).append({
    action: params.action,
    actorUserId: params.actorUserId,
    afterDiff: params.afterDiff,
    reason: params.reason,
    result: params.result,
    targetId: params.targetId,
    targetType: 'skill',
  });
};

export const appendSkillCatalogFailureAudit = async (params: {
  action: AuditAction;
  actorUserId: string;
  db: LobeChatDatabase | Transaction;
  reason?: string | null;
  targetId: string;
}) => {
  try {
    await appendSkillCatalogAudit({
      ...params,
      afterDiff: { error: 'skill_catalog_mutation_failed' },
      result: 'failure',
    });
  } catch (auditError) {
    console.error('[admin.skills] failure audit append failed', {
      errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
    });
  }
};

export const runSkillCatalogAtomicMutation = async <T>(params: {
  action: AuditAction;
  actorUserId: string;
  beforeSuccessAudit?: () => Promise<void>;
  db: LobeChatDatabase;
  reason?: string | null;
  run: (tx: Transaction) => Promise<T>;
  summarize: (result: T) => Record<string, unknown>;
  targetId: (result?: T) => string;
}): Promise<T> => {
  try {
    return await params.db.transaction(async (tx) => {
      const result = await params.run(tx);
      await params.beforeSuccessAudit?.();
      await appendSkillCatalogAudit({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: params.summarize(result),
        db: tx,
        reason: params.reason,
        result: 'success',
        targetId: params.targetId(result),
      });
      return result;
    });
  } catch (error) {
    await appendSkillCatalogFailureAudit({
      action: params.action,
      actorUserId: params.actorUserId,
      db: params.db,
      reason: params.reason,
      targetId: params.targetId(),
    });
    throw error;
  }
};

export const assertSkillDraft = async (
  tx: Transaction,
  model: PlatformSkillCatalogModel,
  input: {
    expectedDraftToken: string;
    expectedRevision: number;
    id: string;
  },
) => {
  const repository = new PlatformSkillCatalogRepository(tx);
  const locked = await repository.lockSkill(input.id);
  if (!locked) throw new SkillCatalogNotFoundError();
  const detail = await model.getDetail(input.id);
  if (!detail) throw new SkillCatalogNotFoundError();
  // Archived is terminal for draft mutations; recovery is rollback only.
  if (detail.draft.status === 'archived') throw new SkillCatalogNotFoundError();
  if (
    detail.baseRevision !== input.expectedRevision ||
    platformSkillDraftToken(detail.draft) !== input.expectedDraftToken
  ) {
    throw new PlatformRevisionConflictError('Skill draft changed', {
      currentRevision: detail.baseRevision,
      expectedRevision: input.expectedRevision,
      resourceId: input.id,
      resourceType: 'skill',
    });
  }
  return detail;
};
