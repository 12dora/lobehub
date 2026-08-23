import { isRecord } from '@lobechat/utils/object';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { PlatformAiCatalogModel } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import {
  platformAiModels,
  type PlatformAiProviderItem,
  type PlatformAiProviderSecretItem,
  type PlatformRevisionStatus,
} from '@/database/schemas/platform';
import type { Transaction } from '@/database/type';

import { aiModelDraftSchema } from '../../contracts/aiCatalog';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { AiCatalogNotFoundError, AiCatalogValidationError } from './errors';
import { coercePublishedProviderColumns, toPublishedModelRows } from './publicationCoercion';
import type { AiCatalogSecretManager } from './secretManager';
import { aiCatalogDraftToken } from './shared';

type PublishedModelDraft = z.infer<typeof aiModelDraftSchema>;

export const parsePublishedRevisionPayload = (payload: Record<string, unknown>) => {
  if (!isRecord(payload.provider) || !Array.isArray(payload.models)) {
    throw new AiCatalogValidationError(['Revision payload is invalid']);
  }
  return {
    models: payload.models.map((model) => aiModelDraftSchema.parse(model)),
    provider: payload.provider,
  };
};

export const isDeactivatingPublishedProvider = (
  operation: 'publish' | 'rollback',
  provider: Record<string, unknown>,
  currentPublishedPayload: Record<string, unknown> | null,
) => operation === 'publish' && provider.enabled === false && currentPublishedPayload !== null;

export const loadPublishSecretVersion = async (
  repository: PlatformAiCatalogRepository,
  providerId: string,
  secretFingerprint: string | null | undefined,
) => {
  const secretVersion = secretFingerprint
    ? await repository.getProviderSecretVersion(providerId, secretFingerprint)
    : undefined;
  if (secretFingerprint && !secretVersion) {
    throw new AiCatalogValidationError(['Referenced provider secret version is unavailable']);
  }
  return secretVersion;
};

export const decryptPublishKeyVaults = async (
  secrets: AiCatalogSecretManager,
  secretVersion: PlatformAiProviderSecretItem | undefined,
  isDeactivatingPublished: boolean,
) =>
  secretVersion && !isDeactivatingPublished ? await secrets.decrypt(secretVersion.ciphertext) : {};

export const publishedSecretPointerColumns = (
  isDeactivatingPublished: boolean,
  storedProvider: Pick<
    PlatformAiProviderItem,
    'secretKeyId' | 'secretKeyVersion' | 'secretUpdatedAt'
  >,
  secretVersion:
    Pick<PlatformAiProviderSecretItem, 'ciphertext' | 'keyVersion' | 'createdAt'> | undefined,
  secrets: AiCatalogSecretManager,
) =>
  isDeactivatingPublished
    ? {
        secretKeyId: storedProvider.secretKeyId,
        secretKeyVersion: storedProvider.secretKeyVersion,
        secretUpdatedAt: storedProvider.secretUpdatedAt,
      }
    : {
        secretKeyId: secretVersion ? secrets.peekKeyId(secretVersion.ciphertext) : null,
        secretKeyVersion: secretVersion?.keyVersion ?? null,
        secretUpdatedAt: secretVersion?.createdAt ?? null,
      };

export const replacePublishedModelRows = async (
  tx: Transaction,
  models: PublishedModelDraft[],
  params: {
    actorUserId: string;
    providerId: string;
    revision: number;
    status: PlatformRevisionStatus;
  },
) => {
  await tx.delete(platformAiModels).where(eq(platformAiModels.providerId, params.providerId));
  if (models.length === 0) return;
  const rows = toPublishedModelRows(models, params);
  await tx.insert(platformAiModels).values(rows);
};

export const stampConnectionTestOnSuccessfulPublish = async (
  tx: Transaction,
  repository: PlatformAiCatalogRepository,
  providerId: string,
  revision: number,
  operation: 'publish' | 'rollback',
  status: PlatformRevisionStatus,
) => {
  if (operation !== 'publish' || status !== 'published') return;
  const publishedDraft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
  if (publishedDraft?.connectionTest?.status !== 'success') return;
  await repository.updateProvider(providerId, {
    connectionTestedDraftToken: aiCatalogDraftToken(publishedDraft),
    connectionTestedRevision: revision,
  });
};

export const materializePublishedProvider = async (
  tx: Transaction,
  params: {
    actorUserId: string;
    afterCredentialCheck?: () => Promise<void>;
    currentPublishedPayload: Record<string, unknown> | null;
    operation: 'publish' | 'rollback';
    payload: Record<string, unknown>;
    providerId: string;
    revision: number;
    secretFingerprint?: string | null;
    secrets: AiCatalogSecretManager;
    status: PlatformRevisionStatus;
  },
) => {
  const { models, provider } = parsePublishedRevisionPayload(params.payload);
  const repository = new PlatformAiCatalogRepository(tx);
  const storedProvider = await repository.getProvider(params.providerId);
  if (!storedProvider) throw new AiCatalogNotFoundError();
  const secretVersion = await loadPublishSecretVersion(
    repository,
    params.providerId,
    params.secretFingerprint,
  );
  const isDeactivatingPublished = isDeactivatingPublishedProvider(
    params.operation,
    provider,
    params.currentPublishedPayload,
  );
  const keyVaults = await decryptPublishKeyVaults(
    params.secrets,
    secretVersion,
    isDeactivatingPublished,
  );
  assertAiCatalogPublicFieldsExcludeCredentials(params.payload, keyVaults);
  await params.afterCredentialCheck?.();
  await repository.updateProvider(params.providerId, {
    ...coercePublishedProviderColumns(provider),
    encryptedKeyVaults: secretVersion?.ciphertext ?? null,
    revision: params.revision,
    secretFingerprint: secretVersion?.fingerprint ?? null,
    ...publishedSecretPointerColumns(
      isDeactivatingPublished,
      storedProvider,
      secretVersion,
      params.secrets,
    ),
    status: params.status === 'archived' ? 'archived' : 'published',
    updatedBy: params.actorUserId,
  });
  await replacePublishedModelRows(tx, models, {
    actorUserId: params.actorUserId,
    providerId: params.providerId,
    revision: params.revision,
    status: params.status,
  });
  await stampConnectionTestOnSuccessfulPublish(
    tx,
    repository,
    params.providerId,
    params.revision,
    params.operation,
    params.status,
  );
};
