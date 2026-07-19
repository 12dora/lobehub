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

/** Secret-free defaults shared by schema, server validation, and later Admin UI work. */
export interface PlatformIdentityProviderTemplate {
  buttonLabel: string;
  claimMapping: PlatformIdentityProviderClaimMapping;
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
}

export const AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE = {
  buttonLabel: '使用工作账号登录',
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
  buttonLabel: '使用工作账号登录',
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
  fingerprint: string | null;
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
  providerKey: string;
  revision: number;
  scopes: string[];
  secret: PlatformIdentityProviderSecretState;
  status: PlatformIdentityProviderStatus;
  type: PlatformIdentityProviderType;
  usePkce: boolean;
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
