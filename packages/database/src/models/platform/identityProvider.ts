import {
  parsePlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderDraft,
} from '@lobechat/types';

import { PlatformIdentityProviderRepository } from '../../repositories/platformIdentityProvider';
import type { PlatformIdentityProviderItem } from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';
import { containsSensitiveMaterial, isSensitiveKey } from './redact';

const hasCredentialBearingUrl = (value: string): boolean => {
  const starts = [...value.matchAll(/[a-z][a-z0-9+.-]*:\/\//gi)].map((match) => match.index);
  return starts.some((start, index) => {
    const remainder = value.slice(start, starts[index + 1] ?? value.length);
    const boundary = remainder.search(/[\s<>"']/u);
    try {
      const url = new URL(remainder.slice(0, boundary < 0 ? remainder.length : boundary));
      return (
        Boolean(url.username || url.password) || [...url.searchParams.keys()].some(isSensitiveKey)
      );
    } catch {
      return false;
    }
  });
};

const containsCredentialMaterial = (input: unknown): boolean => {
  if (containsSensitiveMaterial(input)) return true;
  const stack: unknown[] = [input];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (hasCredentialBearingUrl(value)) return true;
    } else if (Array.isArray(value)) {
      stack.push(...value);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (isSensitiveKey(key) && child !== null && child !== undefined) return true;
        stack.push(child);
      }
    }
  }
  return false;
};

export const toSafeIdentityProviderDraft = (
  row: PlatformIdentityProviderItem,
): PlatformIdentityProviderDraft => {
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
    containsCredentialMaterial(publicConfig)
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
      configured: row.secretRef !== null,
      fingerprint: row.secretFingerprint ?? null,
      updatedAt: row.secretUpdatedAt ?? null,
    },
    status: row.status,
    type: row.type,
    usePkce: true,
  };
};

/** Secret-safe database model used by every future API/revision projection. */
export class PlatformIdentityProviderModel {
  private readonly repository: PlatformIdentityProviderRepository;

  constructor(db: LobeChatDatabase | Transaction) {
    this.repository = new PlatformIdentityProviderRepository(db);
  }

  get = async (id: string): Promise<PlatformIdentityProviderDraft | undefined> => {
    const row = await this.repository.get(id);
    return row ? toSafeIdentityProviderDraft(row) : undefined;
  };

  list = async (): Promise<PlatformIdentityProviderDraft[]> =>
    (await this.repository.list()).map(toSafeIdentityProviderDraft);

  /** Revision seed deliberately contains only configured/fingerprint metadata. */
  prepareRevisionPayload = async (id: string): Promise<PlatformIdentityProviderDraft | null> =>
    (await this.get(id)) ?? null;
}
