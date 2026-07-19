import { asc, eq } from 'drizzle-orm';

import {
  type NewPlatformIdentityProvider,
  type PlatformIdentityProviderItem,
  platformIdentityProviders,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

export type NewSafePlatformIdentityProvider = Omit<
  NewPlatformIdentityProvider,
  'legacyDiscoveryUrl' | 'legacyEncryptedClientSecret'
>;

export type SafePlatformIdentityProviderItem = Omit<
  PlatformIdentityProviderItem,
  'legacyDiscoveryUrl' | 'legacyEncryptedClientSecret'
>;

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
}
