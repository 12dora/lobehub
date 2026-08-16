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
  const domainAllowlist =
    Array.isArray(row.domainAllowlist) &&
    row.domainAllowlist.length <= 256 &&
    row.domainAllowlist.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= 253 && item === item.trim(),
    )
      ? (row.domainAllowlist as string[])
      : null;
  const groupRoleMapping =
    row.groupRoleMapping &&
    typeof row.groupRoleMapping === 'object' &&
    !Array.isArray(row.groupRoleMapping)
      ? (row.groupRoleMapping as Record<string, unknown>)
      : null;
  if (
    !claimMapping ||
    !dingtalkAllowedCorps ||
    claimMapping.email.length === 0 ||
    !scopes?.includes('openid') ||
    !domainAllowlist ||
    !groupRoleMapping ||
    Object.keys(groupRoleMapping).length > 1024 ||
    Object.entries(groupRoleMapping).some(
      ([key, item]) =>
        !key || key.length > 256 || typeof item !== 'string' || !item || item.length > 128,
    ) ||
    typeof row.autoProvision !== 'boolean' ||
    typeof row.buttonLabel !== 'string' ||
    !row.buttonLabel.trim() ||
    row.buttonLabel !== row.buttonLabel.trim() ||
    row.buttonLabel.length > 200 ||
    typeof row.clientId !== 'string' ||
    !row.clientId.trim() ||
    row.clientId !== row.clientId.trim() ||
    row.clientId.length > 1000 ||
    typeof row.displayName !== 'string' ||
    !row.displayName.trim() ||
    row.displayName !== row.displayName.trim() ||
    row.displayName.length > 200 ||
    typeof row.enabled !== 'boolean' ||
    (row.icon !== null && (typeof row.icon !== 'string' || row.icon.length > 4096)) ||
    typeof row.issuer !== 'string' ||
    !row.issuer ||
    row.issuer.length > 4096 ||
    typeof row.providerKey !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(row.providerKey) ||
    typeof row.secretFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.secretFingerprint) ||
    (row.secretUpdatedAt !== undefined &&
      (typeof row.secretUpdatedAt !== 'string' ||
        Number.isNaN(Date.parse(row.secretUpdatedAt)) ||
        new Date(row.secretUpdatedAt).toISOString() !== row.secretUpdatedAt)) ||
    !PLATFORM_IDENTITY_PROVIDER_TYPES.includes(row.type as PlatformIdentityProviderType) ||
    row.usePkce !== true ||
    containsEnterpriseSecretMaterial({
      ...row,
      secretFingerprint: undefined,
      secretUpdatedAt: undefined,
    })
  ) {
    return null;
  }
  try {
    const issuer = new URL(row.issuer);
    if (
      issuer.protocol !== 'https:' ||
      issuer.username ||
      issuer.password ||
      (issuer.port && issuer.port !== '443') ||
      issuer.search ||
      issuer.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }
  // Kinds with a protocol-fixed identity contract are re-verified at the read boundary too:
  // a published revision or an LKG file that was hand-edited (or written by an older/looser
  // build) must not be materialized into a runtime provider with a remapped subject or an
  // issuer that silently means "any organisation".
  if (
    row.type === 'dingtalk'
      ? !isDingTalkIdentityProviderIssuer(row.issuer) ||
        // The key is the sub-domain of the synthesized address; a non-DNS-label key would
        // produce an address the runtime claim validation rejects.
        !isValidDingTalkProviderKey(row.providerKey) ||
        !isCanonicalDingTalkIdentityContract({ claimMapping, scopes }) ||
        // Fail closed: a live DingTalk provider must name at least one allowed organisation,
        // otherwise "allowlist empty" would have to be interpreted at login time.
        dingtalkAllowedCorps.length === 0
      : dingtalkAllowedCorps.length > 0
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
    domainAllowlist,
    enabled: row.enabled as boolean,
    groupRoleMapping: groupRoleMapping as Record<string, string>,
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
