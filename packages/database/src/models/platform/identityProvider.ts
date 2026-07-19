import {
  parsePlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderDraft,
  type PlatformIdentityProviderSecretState,
} from '@lobechat/types';

import {
  PlatformIdentityProviderRepository,
  type SafePlatformIdentityProviderItem,
  type SafePlatformIdentityProviderListItem,
} from '../../repositories/platformIdentityProvider';
import type { LobeChatDatabase, Transaction } from '../../type';
import { containsEnterpriseSecretMaterial, isSensitiveKey } from './redact';

export interface PlatformIdentityProviderInternalSecretState extends PlatformIdentityProviderSecretState {
  fingerprint: string | null;
}

export type PlatformIdentityProviderInternalDraft = Omit<
  PlatformIdentityProviderDraft,
  'secret'
> & {
  secret: PlatformIdentityProviderInternalSecretState;
};

const toSafeDraft = (
  row: Omit<SafePlatformIdentityProviderItem, 'secretRef'>,
  secretConfigured: boolean,
): PlatformIdentityProviderInternalDraft => {
  const claimMapping = parsePlatformIdentityProviderClaimMapping(row.claimMapping);
  const publicConfig = {
    buttonLabel: row.buttonLabel,
    claimMapping: row.claimMapping,
    clientId: row.clientId,
    displayName: row.displayName,
    domainAllowlist: row.domainAllowlist,
    groupRoleMapping: row.groupRoleMapping,
    icon: row.icon,
    issuer: row.issuer,
    providerKey: row.providerKey,
    scopes: row.scopes,
  };
  const hasCredentialClaim = claimMapping
    ? Object.values(claimMapping).some((claims) => claims.some(isSensitiveKey))
    : true;
  if (
    !claimMapping ||
    hasCredentialClaim ||
    row.usePkce !== true ||
    containsEnterpriseSecretMaterial(publicConfig)
  ) {
    throw new Error('PLATFORM_IDENTITY_PROVIDER_INVALID_PERSISTED_CONFIG');
  }
  return {
    activationRevision: row.activationRevision ?? null,
    autoProvision: row.autoProvision,
    buttonLabel: row.buttonLabel,
    claimMapping,
    clientId: row.clientId,
    displayName: row.displayName,
    domainAllowlist: row.domainAllowlist,
    enabled: row.enabled,
    groupRoleMapping: row.groupRoleMapping,
    icon: row.icon ?? null,
    id: row.id,
    issuer: row.issuer,
    migrationRequired: row.migrationRequired,
    providerKey: row.providerKey,
    revision: row.revision,
    scopes: row.scopes,
    secret: {
      configured: secretConfigured,
      fingerprint: row.secretFingerprint ?? null,
      updatedAt: row.secretUpdatedAt ?? null,
    },
    status: row.status,
    type: row.type,
    usePkce: true,
  };
};

export const toSafeIdentityProviderDraft = (
  row: SafePlatformIdentityProviderItem,
): PlatformIdentityProviderInternalDraft => toSafeDraft(row, row.secretRef !== null);

export const toSafeIdentityProviderDraftFromList = (
  row: SafePlatformIdentityProviderListItem,
): PlatformIdentityProviderInternalDraft => toSafeDraft(row, row.secretConfigured);

export const toPublicIdentityProviderDraft = (
  draft: PlatformIdentityProviderInternalDraft,
): PlatformIdentityProviderDraft => {
  const { secret, ...publicDraft } = draft;
  return {
    ...publicDraft,
    secret: { configured: secret.configured, updatedAt: secret.updatedAt },
  };
};

/** Secret-safe database model used by every future API/revision projection. */
export class PlatformIdentityProviderModel {
  private readonly repository: PlatformIdentityProviderRepository;

  constructor(db: LobeChatDatabase | Transaction) {
    this.repository = new PlatformIdentityProviderRepository(db);
  }

  get = async (id: string): Promise<PlatformIdentityProviderInternalDraft | undefined> => {
    const row = await this.repository.get(id);
    return row ? toSafeIdentityProviderDraft(row) : undefined;
  };

  list = async (): Promise<PlatformIdentityProviderInternalDraft[]> =>
    (await this.repository.list()).map(toSafeIdentityProviderDraft);

  /** Revision seed deliberately contains only configured/fingerprint metadata. */
  prepareRevisionPayload = async (
    id: string,
  ): Promise<PlatformIdentityProviderInternalDraft | null> => (await this.get(id)) ?? null;
}
