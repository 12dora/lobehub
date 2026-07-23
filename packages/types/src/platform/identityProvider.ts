export const PLATFORM_IDENTITY_PROVIDER_TYPES = ['authentik', 'generic_oidc'] as const;

export type PlatformIdentityProviderType = (typeof PLATFORM_IDENTITY_PROVIDER_TYPES)[number];

export const PLATFORM_IDENTITY_PROVIDER_STATUSES = [
  'draft',
  'published',
  'pending_restart',
  'active',
  'error',
  'disabled',
  'archived',
] as const;

export type PlatformIdentityProviderStatus = (typeof PLATFORM_IDENTITY_PROVIDER_STATUSES)[number];

/** Ordered claim names. The first non-empty string is used by the runtime adapter. */
export interface PlatformIdentityProviderClaimMapping {
  dingtalkTitle: string[];
  dingtalkUserId: string[];
  email: string[];
  name: string[];
  picture: string[];
  subject: string[];
}

export const PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS = [
  'dingtalkTitle',
  'dingtalkUserId',
  'email',
  'name',
  'picture',
  'subject',
] as const;

const CLAIM_NAME_PATTERN = /^[\w.:-]{1,128}$/;

/** Runtime parser for data crossing the untrusted persistence boundary. */
export const parsePlatformIdentityProviderClaimMapping = (
  value: unknown,
): PlatformIdentityProviderClaimMapping | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS.length ||
    Object.keys(record).some(
      (key) =>
        !PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS.includes(
          key as (typeof PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS)[number],
        ),
    )
  ) {
    return null;
  }
  const result = {} as PlatformIdentityProviderClaimMapping;
  for (const key of PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS) {
    const candidates = record[key];
    if (
      !Array.isArray(candidates) ||
      candidates.length > 8 ||
      candidates.some(
        (candidate) => typeof candidate !== 'string' || !CLAIM_NAME_PATTERN.test(candidate),
      ) ||
      new Set(candidates).size !== candidates.length
    ) {
      return null;
    }
    result[key] = [...candidates] as string[];
  }
  if (result.subject.length === 0 || result.name.length === 0) return null;
  return result;
};

export const OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS = [
  'RS256',
  'PS256',
  'ES256',
  'EdDSA',
] as const;

/** Secret-free defaults shared by schema, server validation, and later Admin UI work. */
export interface PlatformIdentityProviderTemplate {
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderClaimMapping;
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
}

/** Default sign-in button label shared by the provider templates below. */
const DEFAULT_IDP_BUTTON_LABEL = '使用工作账号登录' as const;

export const AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE = {
  buttonLabel: DEFAULT_IDP_BUTTON_LABEL,
  claimMapping: {
    dingtalkTitle: ['dingtalk_title'],
    dingtalkUserId: ['dingtalk_user_id'],
    email: ['email'],
    name: ['name', 'preferred_username'],
    picture: ['picture'],
    subject: ['sub'],
  },
  scopes: ['openid', 'profile', 'email', 'dingtalk'],
  type: 'authentik',
  usePkce: true,
} as const satisfies PlatformIdentityProviderTemplate;

export const GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE = {
  buttonLabel: DEFAULT_IDP_BUTTON_LABEL,
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name', 'preferred_username'],
    picture: ['picture'],
    subject: ['sub'],
  },
  scopes: ['openid', 'profile', 'email'],
  type: 'generic_oidc',
  usePkce: true,
} as const satisfies PlatformIdentityProviderTemplate;

export const PLATFORM_IDENTITY_PROVIDER_TEMPLATES = {
  authentik: AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE,
  generic_oidc: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
} as const satisfies Record<PlatformIdentityProviderType, PlatformIdentityProviderTemplate>;

export interface PlatformIdentityProviderSecretState {
  configured: boolean;
  updatedAt: Date | null;
}

/** Safe projection. Secret refs, ciphertext, and key ids are intentionally absent. */
export interface PlatformIdentityProviderDraft {
  activationRevision: number | null;
  autoProvision: boolean;
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderClaimMapping;
  clientId: string | null;
  displayName: string;
  domainAllowlist: string[];
  enabled: boolean;
  groupRoleMapping: Record<string, string>;
  icon: string | null;
  id: string;
  issuer: string | null;
  migrationRequired: boolean;
  providerKey: string;
  revision: number;
  scopes: string[];
  secret: PlatformIdentityProviderSecretState;
  status: PlatformIdentityProviderStatus;
  type: PlatformIdentityProviderType;
  usePkce: true;
}

/** Validated OpenID Provider metadata. Unknown discovery fields never cross this boundary. */
export interface PlatformOidcDiscoveryMetadata {
  authorizationEndpoint: string;
  codeChallengeMethodsSupported: string[];
  idTokenSigningAlgValuesSupported: string[];
  issuer: string;
  jwksUri: string;
  responseTypesSupported: string[];
  scopesSupported: string[];
  subjectTypesSupported: string[];
  tokenEndpoint: string;
  tokenEndpointAuthMethodsSupported: string[];
  userinfoEndpoint: string | null;
}

export const PLATFORM_IDENTITY_PROVIDER_TEST_ATTEMPT_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'failed',
] as const;

export type PlatformIdentityProviderTestAttemptStatus =
  (typeof PLATFORM_IDENTITY_PROVIDER_TEST_ATTEMPT_STATUSES)[number];

export const PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS = [
  'dingtalk_title',
  'dingtalk_user_id',
  'email',
  'name',
  'picture',
  'preferred_username',
  'sub',
] as const;

export type PlatformIdentityProviderPreviewClaim =
  (typeof PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS)[number];

export interface PlatformIdentityProviderClaimValidationIssue {
  code: 'required_claim_missing';
  field: 'name' | 'subject';
}

export interface PlatformIdentityProviderClaimPreview {
  claims: Partial<Record<PlatformIdentityProviderPreviewClaim, string>>;
  issues: PlatformIdentityProviderClaimValidationIssue[];
  valid: boolean;
}
