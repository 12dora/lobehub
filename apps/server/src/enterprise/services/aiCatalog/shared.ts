import { isRecord } from '@lobechat/utils/object';
import isEqual from 'fast-deep-equal';

import {
  platformAiCatalogDraftToken,
  PlatformAiCatalogModel,
  type PlatformAiProviderDraftView,
  PlatformRevisionConflictError,
} from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { AuditAction } from '../audit/auditActionCatalog';
import { PlatformAuditService } from '../platformAudit';
import { AiCatalogNotFoundError } from './errors';

export const aiCatalogDraftToken = platformAiCatalogDraftToken;

/**
 * Connectivity-sensitive provider state used to decide whether a prior connection test may be
 * reused. Cosmetic fields (displayName, description, logo, sort, enabled, models metadata) are
 * intentionally excluded — any other config/settings/checkModel/secret change forces a retest.
 */
export interface AiCatalogConnectivityFingerprint {
  checkModel: string | null;
  /** Full provider config (deep-compared). */
  config: Record<string, unknown>;
  secretFingerprint: string | null;
  /** Full provider settings (deep-compared). */
  settings: Record<string, unknown>;
}

const asObject = (value: unknown): Record<string, unknown> => (isRecord(value) ? { ...value } : {});

export const getAiCatalogConnectivityFingerprint = (params: {
  checkModel?: string | null;
  config?: unknown;
  secretFingerprint?: string | null;
  settings?: unknown;
}): AiCatalogConnectivityFingerprint => ({
  checkModel: typeof params.checkModel === 'string' ? params.checkModel : null,
  config: asObject(params.config),
  secretFingerprint: typeof params.secretFingerprint === 'string' ? params.secretFingerprint : null,
  settings: asObject(params.settings),
});

export const aiCatalogConnectivityEquals = (
  left: AiCatalogConnectivityFingerprint,
  right: AiCatalogConnectivityFingerprint,
): boolean =>
  left.checkModel === right.checkModel &&
  left.secretFingerprint === right.secretFingerprint &&
  isEqual(left.config, right.config) &&
  isEqual(left.settings, right.settings);

export const getDraftConnectivityFingerprint = (
  draft: PlatformAiProviderDraftView,
): AiCatalogConnectivityFingerprint =>
  getAiCatalogConnectivityFingerprint({
    checkModel: draft.checkModel,
    config: draft.config,
    secretFingerprint: draft.secret.fingerprint,
    settings: draft.settings,
  });

/**
 * Compare a live draft against a published revision's connectivity fields.
 * Secret fingerprint MUST come from the revision row column (`secretFingerprint`), not the
 * payload body — publish redacts `provider.secretFingerprint` inside the stored payload.
 */
export const publishedPayloadConnectivityMatchesDraft = (
  draft: PlatformAiProviderDraftView,
  params: {
    payload: Record<string, unknown> | null | undefined;
    /** Unredacted fingerprint from `platform_resource_revisions.secret_fingerprint`. */
    secretFingerprint?: string | null;
  },
): boolean => {
  const payload = params.payload;
  if (!payload || !isRecord(payload.provider)) return false;
  const provider = payload.provider;
  const published = getAiCatalogConnectivityFingerprint({
    checkModel: typeof provider.checkModel === 'string' ? provider.checkModel : null,
    config: provider.config,
    secretFingerprint: params.secretFingerprint ?? null,
    settings: provider.settings,
  });
  return aiCatalogConnectivityEquals(getDraftConnectivityFingerprint(draft), published);
};

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
  params: { action: AuditAction; actorUserId: string; reason: string; targetId?: string },
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
