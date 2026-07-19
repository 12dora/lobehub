import type { PlatformIdentityProviderDraft } from '@lobechat/types';
import { and, asc, eq, gt, ilike, or } from 'drizzle-orm';

import { PlatformIdentityProviderModel } from '@/database/models/platform';
import {
  platformIdentityProviders,
  platformIdentityProviderSecrets,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

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

const requireDraft = (draft: PlatformIdentityProviderDraft | undefined) => {
  if (!draft) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
  if (draft.migrationRequired) throw new Error('PLATFORM_IDENTITY_PROVIDER_MIGRATION_REQUIRED');
  if (draft.status !== 'draft') throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_DRAFT');
  return draft;
};

/** Draft-only administration. Published/activation lifecycle is deliberately out of scope. */
export class AdminIdentityProviderService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secretService: PlatformSecretService,
    private readonly discovery: IdentityProviderDiscoveryValidator,
    private readonly appUrl: string,
  ) {}

  get = async (id: string): Promise<PlatformIdentityProviderDraft> =>
    requireDraft(await new PlatformIdentityProviderModel(this.db).get(id));

  list = async (input: AdminIdentityProviderListInput) => {
    const filters = [
      input.cursor ? gt(platformIdentityProviders.providerKey, input.cursor) : undefined,
      input.status ? eq(platformIdentityProviders.status, input.status) : undefined,
      input.type ? eq(platformIdentityProviders.type, input.type) : undefined,
      input.query
        ? or(
            ilike(platformIdentityProviders.providerKey, `%${input.query}%`),
            ilike(platformIdentityProviders.displayName, `%${input.query}%`),
          )
        : undefined,
    ].filter(Boolean);
    const rows = await this.db
      .select({
        id: platformIdentityProviders.id,
        providerKey: platformIdentityProviders.providerKey,
      })
      .from(platformIdentityProviders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(platformIdentityProviders.providerKey))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const model = new PlatformIdentityProviderModel(this.db);
    const items = await Promise.all(page.map(({ id }) => model.get(id)));
    return {
      items: items.filter((item): item is PlatformIdentityProviderDraft => Boolean(item)),
      nextCursor: hasMore ? page.at(-1)!.providerKey : null,
    };
  };

  create = async (actorUserId: string, input: AdminIdentityProviderCreateInput) =>
    this.db.transaction(async (tx) => {
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
      const draft = requireDraft(await new PlatformIdentityProviderModel(tx).get(created.id));
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
    });

  update = async (actorUserId: string, input: AdminIdentityProviderUpdateInput) =>
    this.db.transaction(async (tx) => {
      const model = new PlatformIdentityProviderModel(tx);
      const before = requireDraft(await model.get(input.id));
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
            eq(platformIdentityProviders.status, 'draft'),
          ),
        )
        .returning({ id: platformIdentityProviders.id });
      if (!updated) throw new Error('PLATFORM_REVISION_CONFLICT');
      const after = requireDraft(await model.get(input.id));
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
    });

  delete = async (
    actorUserId: string,
    input: { expectedRevision: number; id: string; reason: string },
  ) =>
    this.db.transaction(async (tx) => {
      const before = requireDraft(await new PlatformIdentityProviderModel(tx).get(input.id));
      if (before.revision !== input.expectedRevision) throw new Error('PLATFORM_REVISION_CONFLICT');
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
    });

  discoverIssuer = async (issuer: string) => this.discovery.discover(issuer);

  validateNetwork = async (issuer: string) => {
    await this.discovery.validateNetwork(issuer);
    return { valid: true as const };
  };

  getCallbackUrls = () => {
    const base = new URL(this.appUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
      throw new Error('PLATFORM_APP_URL_INVALID');
    }
    return {
      production: `${base.origin}/api/auth/callback/{providerKey}`,
      test: new URL('/oauth/identity-provider/test/callback', base).toString(),
    };
  };
}
