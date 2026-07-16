import {
  checksumPayload,
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import { PlatformAuditService } from '../platformAudit';
import { AiCatalogNotFoundError } from './errors';

export const aiCatalogDraftToken = (draft: PlatformAiProviderDraftView): string =>
  checksumPayload({ draft, revision: draft.revision });

export const getLockedAiCatalogDraft = async (params: {
  afterLock?: () => Promise<void>;
  expectedDraftToken: string;
  expectedRevision?: number;
  providerId: string;
  tx: Transaction;
}): Promise<PlatformAiProviderDraftView> => {
  const repository = new PlatformAiCatalogRepository(params.tx);
  const locked = await repository.lockProvider(params.providerId);
  if (!locked) throw new AiCatalogNotFoundError();
  await params.afterLock?.();
  if (params.expectedRevision !== undefined && locked.revision !== params.expectedRevision) {
    throw new PlatformRevisionConflictError('Provider revision changed');
  }
  const draft = await new PlatformAiCatalogModel(params.tx).getProvider(params.providerId);
  if (!draft) throw new AiCatalogNotFoundError();
  if (aiCatalogDraftToken(draft) !== params.expectedDraftToken) {
    throw new PlatformRevisionConflictError('Provider draft token changed');
  }
  return draft;
};

export const appendAiCatalogFailureAudit = async (
  db: LobeChatDatabase,
  params: { action: string; actorUserId: string; reason: string; targetId?: string },
): Promise<void> => {
  try {
    await new PlatformAuditService(db).append({
      action: params.action,
      actorUserId: params.actorUserId,
      afterDiff: { error: 'operation_failed' },
      reason: params.reason,
      result: 'failure',
      targetId: params.targetId ?? null,
      targetType: 'provider',
    });
  } catch (error) {
    console.error('[admin.aiCatalog] failure audit append failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};
