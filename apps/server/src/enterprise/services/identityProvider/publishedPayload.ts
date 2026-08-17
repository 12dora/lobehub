import type { PlatformIdentityProviderInternalDraft } from '@/database/models/platform';
import {
  isCanonicalDingTalkIdentityContract,
  isDingTalkIdentityProviderIssuer,
  isValidDingTalkProviderKey,
  parseDingTalkAllowedCorps,
  parsePlatformIdentityProviderClaimMapping,
  PLATFORM_IDENTITY_PROVIDER_TYPES,
  type PlatformIdentityProviderAllowedCorp,
  type PlatformIdentityProviderType,
} from '@/types/platform/identityProvider';

import { containsEnterpriseSecretMaterial } from '../../security/redaction';

export interface PublishedIdentityProviderPayload {
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderInternalDraft['claimMapping'];
  clientId: string;
  /** Organisations allowed to sign in (kind `dingtalk`); `[]` for every other kind. */
  dingtalkAllowedCorps: PlatformIdentityProviderAllowedCorp[];
  displayName: string;
  domainAllowlist: string[];
  /**
   * `true` = live login provider. `false` = signed tombstone/removal revision.
   * Startup and LKG must honor tombstones (do not materialize; allow monotonic removal).
   */
  enabled: boolean;
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  issuer: string;
  providerKey: string;
  scopes: string[];
  secretFingerprint: string;
  secretUpdatedAt?: string;
  type: PlatformIdentityProviderType;
  usePkce: true;
}

export class IdentityProviderPublicationError extends Error {
  constructor(
    public readonly code:
      | 'PLATFORM_IDENTITY_PROVIDER_INVALID_SNAPSHOT'
      | 'PLATFORM_IDENTITY_PROVIDER_CORP_ALLOWLIST_REQUIRED'
      | 'PLATFORM_IDENTITY_PROVIDER_DRAFT_REQUIRED'
      | 'PLATFORM_IDENTITY_PROVIDER_IDEMPOTENCY_CONFLICT'
      | 'PLATFORM_IDENTITY_PROVIDER_REQUEST_PENDING'
      | 'PLATFORM_IDENTITY_PROVIDER_NOT_FOUND'
      | 'PLATFORM_IDENTITY_PROVIDER_NOT_TESTED'
      | 'PLATFORM_IDENTITY_PROVIDER_SECRET_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'IdentityProviderPublicationError';
  }
}

const parseStringArray = (value: unknown, maximum: number): string[] | null => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== 'string' || item.length > 128 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(item),
    ) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return [...value] as string[];
};

const isBoundedTrimmedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  value === value.trim() &&
  value.length <= max;

const isValidDomainAllowlist = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= 256 &&
  value.every(
    (item) =>
      typeof item === 'string' && item.length > 0 && item.length <= 253 && item === item.trim(),
  );

const isValidGroupRoleMapping = (value: unknown): value is Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const mapping = value as Record<string, unknown>;
  return !(
    Object.keys(mapping).length > 1024 ||
    Object.entries(mapping).some(
      ([key, item]) =>
        !key || key.length > 256 || typeof item !== 'string' || !item || item.length > 128,
    )
  );
};

const isValidSecretUpdatedAt = (value: unknown): boolean =>
  value === undefined ||
  (typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value);

const isValidPublishedIssuerUrl = (issuer: string): boolean => {
  try {
    const parsed = new URL(issuer);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      (parsed.port && parsed.port !== '443') ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const matchesFixedProtocolContract = ({
  claimMapping,
  dingtalkAllowedCorps,
  issuer,
  providerKey,
  scopes,
  type,
}: {
  claimMapping: NonNullable<ReturnType<typeof parsePlatformIdentityProviderClaimMapping>>;
  dingtalkAllowedCorps: NonNullable<ReturnType<typeof parseDingTalkAllowedCorps>>;
  issuer: string;
  providerKey: string;
  scopes: string[];
  type: unknown;
}): boolean =>
  !(type === 'dingtalk'
    ? !isDingTalkIdentityProviderIssuer(issuer) ||
      // The key is the sub-domain of the synthesized address; a non-DNS-label key would
      // produce an address the runtime claim validation rejects.
      !isValidDingTalkProviderKey(providerKey) ||
      !isCanonicalDingTalkIdentityContract({ claimMapping, scopes }) ||
      // Fail closed: a live DingTalk provider must name at least one allowed organisation,
      // otherwise "allowlist empty" would have to be interpreted at login time.
      dingtalkAllowedCorps.length === 0
    : dingtalkAllowedCorps.length > 0);

export const parsePublishedIdentityProviderPayload = (
  value: unknown,
): PublishedIdentityProviderPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const allowedKeys = new Set([
    'autoProvision',
    'buttonLabel',
    'claimMapping',
    'clientId',
    'dingtalkAllowedCorps',
    'displayName',
    'domainAllowlist',
    'enabled',
    'groupRoleMapping',
    'icon',
    'issuer',
    'providerKey',
    'scopes',
    'secretFingerprint',
    'secretUpdatedAt',
    'type',
    'usePkce',
  ]);
  if (Object.keys(row).some((key) => !allowedKeys.has(key))) return null;
  const claimMapping = parsePlatformIdentityProviderClaimMapping(row.claimMapping);
  const dingtalkAllowedCorps = parseDingTalkAllowedCorps(row.dingtalkAllowedCorps ?? []);
  const scopes = parseStringArray(row.scopes, 32);
  if (!claimMapping) return null;
  if (!dingtalkAllowedCorps) return null;
  if (claimMapping.email.length === 0) return null;
  if (!scopes?.includes('openid')) return null;
  if (!isValidDomainAllowlist(row.domainAllowlist)) return null;
  if (!isValidGroupRoleMapping(row.groupRoleMapping)) return null;
  if (typeof row.autoProvision !== 'boolean') return null;
  if (!isBoundedTrimmedString(row.buttonLabel, 200)) return null;
  if (!isBoundedTrimmedString(row.clientId, 1000)) return null;
  if (!isBoundedTrimmedString(row.displayName, 200)) return null;
  if (typeof row.enabled !== 'boolean') return null;
  if (row.icon !== null && (typeof row.icon !== 'string' || row.icon.length > 4096)) return null;
  if (typeof row.issuer !== 'string' || !row.issuer || row.issuer.length > 4096) return null;
  if (
    typeof row.providerKey !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.providerKey)
  ) {
    return null;
  }
  if (typeof row.secretFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.secretFingerprint)) {
    return null;
  }
  if (!isValidSecretUpdatedAt(row.secretUpdatedAt)) return null;
  if (!PLATFORM_IDENTITY_PROVIDER_TYPES.includes(row.type as PlatformIdentityProviderType)) {
    return null;
  }
  if (row.usePkce !== true) return null;
  if (
    containsEnterpriseSecretMaterial({
      ...row,
      secretFingerprint: undefined,
      secretUpdatedAt: undefined,
    })
  ) {
    return null;
  }
  if (!isValidPublishedIssuerUrl(row.issuer)) return null;
  // Kinds with a protocol-fixed identity contract are re-verified at the read boundary too:
  // a published revision or an LKG file that was hand-edited (or written by an older/looser
  // build) must not be materialized into a runtime provider with a remapped subject or an
  // issuer that silently means "any organisation".
  if (
    !matchesFixedProtocolContract({
      claimMapping,
      dingtalkAllowedCorps,
      issuer: row.issuer,
      providerKey: row.providerKey,
      scopes,
      type: row.type,
    })
  ) {
    return null;
  }
  return {
    autoProvision: row.autoProvision,
    buttonLabel: row.buttonLabel,
    claimMapping,
    clientId: row.clientId,
    dingtalkAllowedCorps,
    displayName: row.displayName,
    domainAllowlist: row.domainAllowlist,
    enabled: row.enabled as boolean,
    groupRoleMapping: row.groupRoleMapping,
    icon: row.icon as string | null,
    issuer: row.issuer,
    providerKey: row.providerKey,
    scopes,
    secretFingerprint: row.secretFingerprint,
    secretUpdatedAt: row.secretUpdatedAt as string | undefined,
    type: row.type as PlatformIdentityProviderType,
    usePkce: true,
  };
};
