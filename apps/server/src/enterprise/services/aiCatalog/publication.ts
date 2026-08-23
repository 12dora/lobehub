import type { z } from 'zod';

import type { PlatformAiProviderDraftView } from '@/database/models/platform';
import { PlatformAiCatalogModel } from '@/database/models/platform';
import { PlatformAiCatalogRepository } from '@/database/repositories/platformAiCatalog';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import {
  isCredentialBearingUrl,
  M07_REDACTION_OPTIONS,
} from '@/server/enterprise/security/redaction';

import type {
  adminAiProviderArchiveInputSchema,
  adminAiProviderPublishInputSchema,
  adminAiProviderRollbackInputSchema,
} from '../../contracts/aiCatalog';
import type { AuditAction } from '../audit/auditActionCatalog';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import { invalidateAiCatalogAuthorityToken } from '../platformInstance/catalogTokens';
import type { DeferInvalidation } from '../platformPublisher';
import { PlatformPublisherService } from '../platformPublisher';
import {
  resolveAiCatalogRuntimeProvider,
  validateAiCatalogCredentialShape,
} from './credentialAdapter';
import { assertAiCatalogPublicFieldsExcludeCredentials } from './credentialBoundary';
import { resolveAiCatalogDependentsForModels } from './dependencies';
import { AiCatalogNotFoundError, AiCatalogValidationError } from './errors';
import { sanitizeAiCatalogPersistedText } from './persistentText';
import { createAiCatalogPublicationPointer } from './publication.pointer';
import type { AiCatalogSecretManager } from './secretManager';
import { appendAiCatalogFailureAudit } from './shared';

type PublishProviderInput = z.infer<typeof adminAiProviderPublishInputSchema>;
type ArchiveProviderInput = z.infer<typeof adminAiProviderArchiveInputSchema>;
type RollbackProviderInput = z.infer<typeof adminAiProviderRollbackInputSchema>;

export interface AiCatalogPublicationOptions {
  /**
   * Set when this service runs inside a caller-owned transaction: distributed invalidation
   * events and the local authority-token reset are handed over instead of fired, so nothing
   * announces a revision the enclosing transaction might still roll back.
   */
  deferInvalidation?: DeferInvalidation;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: {
    afterArchiveDependencyCheck?: () => Promise<void>;
    afterModelDependencyCheck?: () => Promise<void>;
    afterPublishLock?: (tx: Transaction) => Promise<void>;
  };
  resolveDependentsForModels?: typeof resolveAiCatalogDependentsForModels;
}

const collectEndpointIssue = (endpoint: string | undefined): string | undefined => {
  if (!endpoint) return undefined;
  try {
    const parsed = new URL(endpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || isCredentialBearingUrl(parsed.href)) {
      return 'Endpoint must be an HTTP(S) URL without credentials';
    }
  } catch {
    return 'Endpoint must be a valid URL';
  }
  return undefined;
};

export class AiCatalogPublicationService {
  private readonly db: LobeChatDatabase;
  private readonly deferInvalidation?: DeferInvalidation;
  private readonly lifecycle: NonNullable<AiCatalogPublicationOptions['lifecycle']>;
  private readonly publisher: PlatformPublisherService;
  private readonly resolveDependentsForModels: typeof resolveAiCatalogDependentsForModels;
  private readonly secrets: AiCatalogSecretManager;

  constructor(
    db: LobeChatDatabase,
    secrets: AiCatalogSecretManager,
    options: AiCatalogPublicationOptions = {},
  ) {
    this.db = db;
    this.deferInvalidation = options.deferInvalidation;
    this.lifecycle = options.lifecycle ?? {};
    this.publisher = new PlatformPublisherService(db, options.invalidation);
    this.resolveDependentsForModels =
      options.resolveDependentsForModels ?? resolveAiCatalogDependentsForModels;
    this.secrets = secrets;
  }

  /** Local authority-token reset — deferred with the distributed event when scoped to a tx. */
  private invalidateAuthorityToken = (): void => {
    if (this.deferInvalidation) {
      this.deferInvalidation(async () => invalidateAiCatalogAuthorityToken());
      return;
    }
    invalidateAiCatalogAuthorityToken();
  };

  private sanitizeReason = async (providerId: string, reason: string): Promise<string> => {
    const provider = await new PlatformAiCatalogRepository(this.db).getProvider(providerId);
    if (!provider?.encryptedKeyVaults) return sanitizeAiCatalogPersistedText(reason);
    try {
      const keyVaults = await this.secrets.decrypt(provider.encryptedKeyVaults);
      return sanitizeAiCatalogPersistedText(reason, [keyVaults]);
    } catch {
      return sanitizeAiCatalogPersistedText(reason);
    }
  };

  /**
   * Publish-time invariants.
   *
   * Every admin write applies immediately (draft write + unconditional publish), so this is
   * a **security / sanity** gate only — never a readiness gate. Publishing a disabled
   * provider, or one with zero models and no credentials, is legal: that is exactly how the
   * settings-page toggle persists site-wide. Chat-time errors surface at chat time.
   *
   * Kept: fetchOnClient-vs-secret, endpoint scheme without embedded credentials, secret
   * decryptability, credential shape for the resolved runtime, and no credential material in
   * public catalog fields.
   */
  private validatePublishDraft = async (
    tx: Transaction,
    providerId: string,
  ): Promise<PlatformAiProviderDraftView> => {
    const repository = new PlatformAiCatalogRepository(tx);
    const draft = await new PlatformAiCatalogModel(tx).getProvider(providerId);
    if (!draft) throw new AiCatalogNotFoundError();
    const issues: string[] = [];
    /**
     * Emergency disable of an already-published provider must survive a KEK/secret outage:
     * publishing `enabled: false` never reads the stored ciphertext (mirrors the same
     * carve-out in `materializePublished`).
     */
    const isDeactivatingPublished = draft.revision > 0 && draft.enabled === false;

    if (draft.secret.configured && draft.fetchOnClient) {
      issues.push('Secret-configured providers must disable fetchOnClient');
    }
    const endpointIssue = collectEndpointIssue(draft.config.endpoint);
    if (endpointIssue) issues.push(endpointIssue);
    const provider = await repository.getProvider(providerId);
    if (!provider) throw new AiCatalogNotFoundError();
    try {
      const keyVaults =
        provider.encryptedKeyVaults && !isDeactivatingPublished
          ? await this.secrets.decrypt(provider.encryptedKeyVaults)
          : {};
      assertAiCatalogPublicFieldsExcludeCredentials(draft, keyVaults);
      if (!isDeactivatingPublished) {
        // Shape only (supported runtime + credential fields belong to it). Completeness is
        // deliberately NOT checked: a credential-less provider is publishable.
        validateAiCatalogCredentialShape(
          resolveAiCatalogRuntimeProvider(draft.providerKey, draft.settings, draft.source),
          keyVaults,
        );
      }
    } catch (error) {
      if (error instanceof AiCatalogValidationError) issues.push(...error.issues);
      else issues.push('Provider secret must be readable');
    }
    if (issues.length > 0) throw new AiCatalogValidationError(issues);
    return draft;
  };

  private createPointer = (
    providerId: string,
    actorUserId: string,
    expectedDraftToken: string,
    options: {
      force?: boolean;
      validateArchiveDependents?: boolean;
      validateForPublish?: boolean;
    } = {},
  ) =>
    createAiCatalogPublicationPointer({
      actorUserId,
      expectedDraftToken,
      force: options.force,
      lifecycle: this.lifecycle,
      providerId,
      resolveDependentsForModels: this.resolveDependentsForModels,
      secrets: this.secrets,
      validateArchiveDependents: options.validateArchiveDependents,
      validateForPublish: options.validateForPublish,
      validatePublishDraft: this.validatePublishDraft,
    });

  private withPublicationAudit = async <T>(
    action: AuditAction,
    actorUserId: string,
    id: string,
    reason: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      await appendAiCatalogFailureAudit(this.db, {
        action,
        actorUserId,
        reason,
        targetId: id,
      });
      throw error;
    }
  };

  publishProvider = async (actorUserId: string, input: PublishProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.publish',
      actorUserId,
      input.id,
      reason,
      async () => {
        const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const result = await this.publisher.publish({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: input.force
            ? ['ai-catalog', 'model-runtime', 'settings']
            : ['ai-catalog', 'model-runtime'],
          payload: {},
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken, {
            force: input.force === true,
          }),
          reason,
          redactionOptions: M07_REDACTION_OPTIONS,
          resourceId: input.id,
          resourceType: 'provider',
          secretFingerprint: draft.secret.fingerprint,
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  archiveProvider = async (actorUserId: string, input: ArchiveProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.archive',
      actorUserId,
      input.id,
      reason,
      async () => {
        const draft = await new PlatformAiCatalogModel(this.db).getProvider(input.id);
        if (!draft) throw new AiCatalogNotFoundError();
        const result = await this.publisher.publish({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: input.force
            ? ['ai-catalog', 'model-runtime', 'settings']
            : ['ai-catalog', 'model-runtime'],
          payload: {},
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken, {
            force: input.force === true,
            validateArchiveDependents: true,
            validateForPublish: false,
          }),
          reason,
          redactionOptions: M07_REDACTION_OPTIONS,
          resourceId: input.id,
          resourceType: 'provider',
          secretFingerprint: draft.secret.fingerprint,
          status: 'archived',
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };

  rollbackProvider = async (actorUserId: string, input: RollbackProviderInput) => {
    const reason = await this.sanitizeReason(input.id, input.reason);
    return this.withPublicationAudit(
      'admin.aiProviders.rollback',
      actorUserId,
      input.id,
      reason,
      async () => {
        const target = await new PlatformAiCatalogRepository(this.db).getProviderRevision(
          input.id,
          input.targetRevision,
        );
        if (!target || target.status !== 'published') {
          throw new AiCatalogValidationError([
            'Rollback target must be a published provider revision',
          ]);
        }
        const result = await this.publisher.rollback({
          actorUserId,
          deferInvalidation: this.deferInvalidation,
          expectedRevision: input.expectedRevision,
          invalidationScopes: input.force
            ? ['ai-catalog', 'model-runtime', 'settings']
            : ['ai-catalog', 'model-runtime'],
          pointer: this.createPointer(input.id, actorUserId, input.expectedDraftToken, {
            force: input.force === true,
          }),
          reason,
          resourceId: input.id,
          resourceType: 'provider',
          targetRevision: input.targetRevision,
        });
        this.invalidateAuthorityToken();
        return { auditId: result.auditId, revision: result.revision.revision };
      },
    );
  };
}
