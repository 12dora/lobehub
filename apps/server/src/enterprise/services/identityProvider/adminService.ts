import { and, eq } from 'drizzle-orm';

import {
  type PlatformIdentityProviderInternalDraft,
  PlatformIdentityProviderModel,
  toPublicIdentityProviderDraft,
  toSafeIdentityProviderDraftFromList,
} from '@/database/models/platform';
import { PlatformIdentityProviderRepository } from '@/database/repositories/platformIdentityProvider';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  AdminIdentityProviderCreateInput,
  AdminIdentityProviderListInput,
  AdminIdentityProviderUpdateInput,
} from '../../contracts/identityProviders';
import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderSecretStore } from './secretStore';

const editableValues = (
  input: AdminIdentityProviderCreateInput | AdminIdentityProviderUpdateInput,
  actorUserId: string,
) => ({
  autoProvision: input.autoProvision,
  buttonLabel: input.buttonLabel,
  claimMapping: input.claimMapping,
  clientId: input.clientId,
  displayName: input.displayName,
  domainAllowlist: input.domainAllowlist,
  groupRoleMapping: input.groupRoleMapping,
  icon: input.icon,
  issuer: input.issuer,
  providerKey: input.providerKey,
  scopes: input.scopes,
  type: input.type,
  updatedBy: actorUserId,
  usePkce: true as const,
});

const requireDraft = (draft: PlatformIdentityProviderInternalDraft | undefined) => {
  if (!draft) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
  if (draft.migrationRequired) throw new Error('PLATFORM_IDENTITY_PROVIDER_MIGRATION_REQUIRED');
  if (draft.status !== 'draft') throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_DRAFT');
  return draft;
};

const requireProvider = (provider: PlatformIdentityProviderInternalDraft | undefined) => {
  if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
  if (provider.migrationRequired) throw new Error('PLATFORM_IDENTITY_PROVIDER_MIGRATION_REQUIRED');
  return provider;
};

const mutationFailureCategory = (error: unknown): string => {
  if (!(error instanceof Error)) return 'identity_provider_mutation_failed';
  if (error.message.includes('REVISION')) return 'revision_conflict';
  if (error.message.includes('NOT_FOUND')) return 'not_found';
  if (error.message.includes('MIGRATION')) return 'migration_required';
  if (error.message.includes('NOT_DRAFT')) return 'not_draft';
  if (error.message.includes('SECRET')) return 'secret_unavailable';
  return 'identity_provider_mutation_failed';
};

/** Draft administration; editing an activated provider forks its published snapshot into a draft. */
export class AdminIdentityProviderService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secretService: PlatformSecretService,
    private readonly discovery: IdentityProviderDiscoveryValidator,
    private readonly appUrl: string,
  ) {}

  get = async (id: string) =>
    toPublicIdentityProviderDraft(
      requireProvider(await new PlatformIdentityProviderModel(this.db).get(id)),
    );

  list = async (input: AdminIdentityProviderListInput) => {
    const page = await new PlatformIdentityProviderRepository(this.db).listPage(input);
    return {
      items: page.items.map((item) =>
        toPublicIdentityProviderDraft(toSafeIdentityProviderDraftFromList(item)),
      ),
      nextCursor: page.nextCursor,
    };
  };

  private mutation = async <T>(input: {
    action: string;
    actorUserId: string;
    reason: string;
    run: (tx: Transaction) => Promise<T>;
    targetId: string;
  }): Promise<T> => {
    try {
      return await this.db.transaction(input.run);
    } catch (error) {
      try {
        await new PlatformAuditService(this.db).append({
          action: input.action,
          actorUserId: input.actorUserId,
          afterDiff: { category: mutationFailureCategory(error) },
          reason: input.reason,
          result: 'failure',
          targetId: input.targetId,
          targetType: 'identity_provider',
        });
      } catch (auditError) {
        console.error('[admin.identityProviders] failure audit unavailable', {
          action: input.action,
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };

  create = async (actorUserId: string, input: AdminIdentityProviderCreateInput) =>
    this.mutation({
      action: 'admin.identityProviders.create',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const [created] = await tx
          .insert(platformIdentityProviders)
          .values({
            ...editableValues(input, actorUserId),
            createdBy: actorUserId,
            enabled: false,
            status: 'draft',
          })
          .returning({ id: platformIdentityProviders.id });
        let revision = 0;
        if (input.secret.operation === 'replace') {
          revision = (
            await new IdentityProviderSecretStore(tx, this.secretService).persistClientSecret({
              expectedRevision: 0,
              providerId: created.id,
              value: input.secret.value,
            })
          ).revision;
        }
        const internalDraft = requireDraft(
          await new PlatformIdentityProviderModel(tx).get(created.id),
        );
        const draft = toPublicIdentityProviderDraft(internalDraft);
        await new PlatformAuditService(tx).append({
          action: 'admin.identityProviders.create',
          actorUserId,
          afterDiff: { ...draft, secret: { configured: draft.secret.configured } },
          configRevision: revision,
          reason: input.reason,
          result: 'success',
          targetId: created.id,
          targetType: 'identity_provider',
        });
        return draft;
      },
      targetId: input.providerKey,
    });

  update = async (actorUserId: string, input: AdminIdentityProviderUpdateInput) =>
    this.mutation({
      action: 'admin.identityProviders.update',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const model = new PlatformIdentityProviderModel(tx);
        const internalBefore = requireProvider(await model.get(input.id));
        const before = toPublicIdentityProviderDraft(internalBefore);
        if (before.status === 'archived') {
          throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_EDITABLE');
        }
        if (before.revision !== input.expectedRevision) {
          throw new Error('PLATFORM_REVISION_CONFLICT');
        }
        let nextRevision = input.expectedRevision + 1;
        if (input.secret.operation === 'replace') {
          nextRevision = (
            await new IdentityProviderSecretStore(tx, this.secretService).persistClientSecret({
              expectedRevision: input.expectedRevision,
              providerId: input.id,
              value: input.secret.value,
            })
          ).revision;
        } else if (input.secret.operation === 'clear') {
          nextRevision = (
            await new IdentityProviderSecretStore(tx, this.secretService).clearCurrentClientSecret({
              expectedRevision: input.expectedRevision,
              providerId: input.id,
            })
          ).revision;
        }
        const [updated] = await tx
          .update(platformIdentityProviders)
          .set({
            ...editableValues(input, actorUserId),
            activationRevision: null,
            enabled: false,
            revision: nextRevision,
            status: 'draft',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(platformIdentityProviders.id, input.id),
              eq(
                platformIdentityProviders.revision,
                input.secret.operation === 'keep' ? input.expectedRevision : nextRevision,
              ),
              eq(platformIdentityProviders.status, before.status),
            ),
          )
          .returning({ id: platformIdentityProviders.id });
        if (!updated) throw new Error('PLATFORM_REVISION_CONFLICT');
        const after = toPublicIdentityProviderDraft(requireDraft(await model.get(input.id)));
        await new PlatformAuditService(tx).append({
          action: 'admin.identityProviders.update',
          actorUserId,
          afterDiff: { ...after, secret: { configured: after.secret.configured } },
          beforeDiff: { ...before, secret: { configured: before.secret.configured } },
          configRevision: after.revision,
          reason: input.reason,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return after;
      },
      targetId: input.id,
    });

  delete = async (
    actorUserId: string,
    input: { expectedRevision: number; id: string; reason: string },
  ) =>
    this.mutation({
      action: 'admin.identityProviders.delete',
      actorUserId,
      reason: input.reason,
      run: async (tx) => {
        const before = requireDraft(await new PlatformIdentityProviderModel(tx).get(input.id));
        if (before.revision !== input.expectedRevision)
          throw new Error('PLATFORM_REVISION_CONFLICT');
        const [published] = await tx
          .select({ id: platformResourceRevisions.id })
          .from(platformResourceRevisions)
          .where(
            and(
              eq(platformResourceRevisions.resourceType, 'oidc'),
              eq(platformResourceRevisions.resourceId, input.id),
              eq(platformResourceRevisions.status, 'published'),
            ),
          )
          .limit(1);
        if (published) {
          throw new Error('PLATFORM_IDENTITY_PROVIDER_HAS_PUBLISHED_REVISION');
        }
        await tx
          .delete(platformIdentityProviderSecrets)
          .where(eq(platformIdentityProviderSecrets.providerId, input.id));
        const [deleted] = await tx
          .delete(platformIdentityProviders)
          .where(
            and(
              eq(platformIdentityProviders.id, input.id),
              eq(platformIdentityProviders.revision, input.expectedRevision),
              eq(platformIdentityProviders.status, 'draft'),
            ),
          )
          .returning({ id: platformIdentityProviders.id });
        if (!deleted) throw new Error('PLATFORM_REVISION_CONFLICT');
        await new PlatformAuditService(tx).append({
          action: 'admin.identityProviders.delete',
          actorUserId,
          beforeDiff: { ...before, secret: { configured: before.secret.configured } },
          configRevision: before.revision,
          reason: input.reason,
          result: 'success',
          targetId: input.id,
          targetType: 'identity_provider',
        });
        return { deleted: true as const };
      },
      targetId: input.id,
    });

  discoverIssuer = async (actorUserId: string, issuer: string) => {
    try {
      const metadata = await this.discovery.discover(issuer);
      try {
        await new PlatformAuditService(this.db).append({
          action: 'admin.identityProviders.discover',
          actorUserId,
          afterDiff: { outcome: 'discovered' },
          result: 'success',
          targetId: 'identity_provider_discovery',
          targetType: 'identity_provider_validation',
        });
      } catch (auditError) {
        console.error('[admin.identityProviders] discover audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      return metadata;
    } catch (error) {
      try {
        await new PlatformAuditService(this.db).append({
          action: 'admin.identityProviders.discover',
          actorUserId,
          afterDiff: { error: 'discovery_failed' },
          result: 'failure',
          targetId: 'identity_provider_discovery',
          targetType: 'identity_provider_validation',
        });
      } catch (auditError) {
        console.error('[admin.identityProviders] discover failure audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };

  validateNetwork = async (actorUserId: string, issuer: string) => {
    try {
      await this.discovery.validateNetwork(issuer);
      try {
        await new PlatformAuditService(this.db).append({
          action: 'admin.identityProviders.validateNetwork',
          actorUserId,
          afterDiff: { valid: true },
          result: 'success',
          targetId: 'identity_provider_network',
          targetType: 'identity_provider_validation',
        });
      } catch (auditError) {
        console.error('[admin.identityProviders] validateNetwork audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      return { valid: true as const };
    } catch (error) {
      try {
        await new PlatformAuditService(this.db).append({
          action: 'admin.identityProviders.validateNetwork',
          actorUserId,
          afterDiff: { error: 'network_validation_failed' },
          result: 'failure',
          targetId: 'identity_provider_network',
          targetType: 'identity_provider_validation',
        });
      } catch (auditError) {
        console.error('[admin.identityProviders] validateNetwork failure audit unavailable', {
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
      throw error;
    }
  };

  getCallbackUrls = () => {
    const base = new URL(this.appUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('PLATFORM_APP_URL_INVALID');
    }
    return {
      production: `${base.origin}/api/auth/oauth2/callback/{providerKey}`,
      test: new URL('/oauth/identity-provider/test/callback', base).toString(),
    };
  };
}
