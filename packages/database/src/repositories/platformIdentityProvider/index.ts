import type { PlatformIdentityProviderStatus, PlatformIdentityProviderType } from '@lobechat/types';
import { and, asc, eq, gt, ilike, or, type SQL, sql } from 'drizzle-orm';

import {
  type NewPlatformIdentityProvider,
  type PlatformIdentityProviderItem,
  platformIdentityProviders,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { likeContains } from '../platformSearch';

export type NewSafePlatformIdentityProvider = Omit<
  NewPlatformIdentityProvider,
  'legacyDiscoveryUrl' | 'legacyEncryptedClientSecret'
>;

export type SafePlatformIdentityProviderItem = Omit<
  PlatformIdentityProviderItem,
  'legacyDiscoveryUrl' | 'legacyEncryptedClientSecret'
>;

export interface ListPlatformIdentityProvidersParams {
  cursor?: string;
  limit: number;
  query?: string;
  status?: PlatformIdentityProviderStatus;
  type?: PlatformIdentityProviderType;
}

export type SafePlatformIdentityProviderListItem = Omit<
  SafePlatformIdentityProviderItem,
  'secretRef'
> & { secretConfigured: boolean };

/** Deliberately excludes both retained legacy compatibility columns. */
const safeColumns = {
  activationRevision: platformIdentityProviders.activationRevision,
  autoProvision: platformIdentityProviders.autoProvision,
  buttonLabel: platformIdentityProviders.buttonLabel,
  claimMapping: platformIdentityProviders.claimMapping,
  clientId: platformIdentityProviders.clientId,
  createdAt: platformIdentityProviders.createdAt,
  createdBy: platformIdentityProviders.createdBy,
  displayName: platformIdentityProviders.displayName,
  domainAllowlist: platformIdentityProviders.domainAllowlist,
  enabled: platformIdentityProviders.enabled,
  groupRoleMapping: platformIdentityProviders.groupRoleMapping,
  icon: platformIdentityProviders.icon,
  id: platformIdentityProviders.id,
  issuer: platformIdentityProviders.issuer,
  migrationRequired: platformIdentityProviders.migrationRequired,
  providerKey: platformIdentityProviders.providerKey,
  revision: platformIdentityProviders.revision,
  scopes: platformIdentityProviders.scopes,
  secretFingerprint: platformIdentityProviders.secretFingerprint,
  secretRef: platformIdentityProviders.secretRef,
  secretUpdatedAt: platformIdentityProviders.secretUpdatedAt,
  status: platformIdentityProviders.status,
  type: platformIdentityProviders.type,
  updatedAt: platformIdentityProviders.updatedAt,
  updatedBy: platformIdentityProviders.updatedBy,
  usePkce: platformIdentityProviders.usePkce,
} satisfies Record<keyof SafePlatformIdentityProviderItem, unknown>;

const { secretRef: _secretRef, ...safeColumnsWithoutSecretRef } = safeColumns;
const safeListColumns = {
  ...safeColumnsWithoutSecretRef,
  secretConfigured: sql<boolean>`${platformIdentityProviders.secretRef} IS NOT NULL`,
} satisfies Record<keyof SafePlatformIdentityProviderListItem, unknown>;

/** Persistence boundary for external login provider drafts. */
export class PlatformIdentityProviderRepository {
  constructor(private readonly db: LobeChatDatabase | Transaction) {}

  create = async (
    values: NewSafePlatformIdentityProvider,
  ): Promise<SafePlatformIdentityProviderItem> => {
    if ('legacyDiscoveryUrl' in values || 'legacyEncryptedClientSecret' in values) {
      throw new Error('PLATFORM_IDENTITY_PROVIDER_LEGACY_FIELDS_FORBIDDEN');
    }
    const [row] = await this.db
      .insert(platformIdentityProviders)
      .values(values)
      .returning(safeColumns);
    return row;
  };

  get = async (id: string): Promise<SafePlatformIdentityProviderItem | undefined> => {
    const [row] = await this.db
      .select(safeColumns)
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, id))
      .limit(1);
    return row;
  };

  getByKey = async (providerKey: string): Promise<SafePlatformIdentityProviderItem | undefined> => {
    const [row] = await this.db
      .select(safeColumns)
      .from(platformIdentityProviders)
      .where(eq(platformIdentityProviders.providerKey, providerKey))
      .limit(1);
    return row;
  };

  list = async (): Promise<SafePlatformIdentityProviderItem[]> =>
    this.db
      .select(safeColumns)
      .from(platformIdentityProviders)
      .orderBy(asc(platformIdentityProviders.providerKey));

  listPage = async (input: ListPlatformIdentityProvidersParams) => {
    const filters: SQL[] = [];
    if (input.cursor) filters.push(gt(platformIdentityProviders.providerKey, input.cursor));
    if (input.status) filters.push(eq(platformIdentityProviders.status, input.status));
    if (input.type) filters.push(eq(platformIdentityProviders.type, input.type));
    if (input.query) {
      // Literal contains — escape LIKE metacharacters (DB-010).
      const pattern = likeContains(input.query);
      const search = or(
        ilike(platformIdentityProviders.providerKey, pattern),
        ilike(platformIdentityProviders.displayName, pattern),
      );
      if (search) filters.push(search);
    }
    const rows = await this.db
      .select(safeListColumns)
      .from(platformIdentityProviders)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(asc(platformIdentityProviders.providerKey))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const items = hasMore ? rows.slice(0, input.limit) : rows;
    return {
      items,
      nextCursor: hasMore ? items.at(-1)!.providerKey : null,
    };
  };
}
