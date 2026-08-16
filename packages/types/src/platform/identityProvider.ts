export const PLATFORM_IDENTITY_PROVIDER_TYPES = ['authentik', 'generic_oidc', 'dingtalk'] as const;

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
  /**
   * Seeded sign-in button icon. `null` = fall back to the provider key.
   * A non-URL value is resolved against the built-in `AuthIcons` map on the sign-in page.
   */
  icon: string | null;
  scopes: string[];
  type: PlatformIdentityProviderType;
  usePkce: true;
}

/** Default sign-in button label shared by the provider templates below. */
export const DEFAULT_IDP_BUTTON_LABEL = '使用工作账号登录' as const;

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
  icon: null,
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
  icon: null,
  scopes: ['openid', 'profile', 'email'],
  type: 'generic_oidc',
  usePkce: true,
} as const satisfies PlatformIdentityProviderTemplate;

/**
 * DingTalk (钉钉) 扫码/账号登录 — plain OAuth 2.0, not OpenID Connect.
 *
 * DingTalk publishes no `.well-known/openid-configuration`, returns no `id_token`, and serves
 * its profile endpoint behind the `x-acs-dingtalk-access-token` header instead of an OIDC
 * Bearer userinfo endpoint. The per-kind adapter owns those deviations; everything below is
 * the secret-free configuration the admin console seeds when creating a DingTalk login method.
 *
 * `usePkce` stays `true` because the column is `CHECK (use_pkce)` platform-wide; the runtime
 * adapter disables PKCE for this kind (DingTalk does not implement RFC 7636).
 *
 * Unlike the OIDC templates this is NOT a starting point an administrator may edit: the claim
 * mapping and scopes below are the *enforced* contract for this kind (see
 * `isCanonicalDingTalkIdentityContract`), because the mapping selects the Better Auth account
 * id. `subject` is `unionId` only — `openId` is app-scoped and would rebind identities after an
 * AppKey change.
 */
export const DINGTALK_IDENTITY_PROVIDER_TEMPLATE = {
  buttonLabel: '使用钉钉登录',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: ['unionId'],
    email: ['email'],
    name: ['nick'],
    picture: ['avatarUrl'],
    subject: ['unionId'],
  },
  icon: 'dingtalk',
  scopes: ['openid', 'corpid'],
  type: 'dingtalk',
  usePkce: true,
} as const satisfies PlatformIdentityProviderTemplate;

export const PLATFORM_IDENTITY_PROVIDER_TEMPLATES = {
  authentik: AUTHENTIK_IDENTITY_PROVIDER_TEMPLATE,
  dingtalk: DINGTALK_IDENTITY_PROVIDER_TEMPLATE,
  generic_oidc: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
} as const satisfies Record<PlatformIdentityProviderType, PlatformIdentityProviderTemplate>;

const sameStringList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * The DingTalk identity contract is protocol-fixed, not administrator-configurable: the claim
 * mapping decides which DingTalk field becomes the Better Auth account id, so an API caller
 * remapping `subject` to `nick`/`email` could impersonate or collide accounts. Enforced at the
 * write boundary (create/update zod) AND at the published-payload/LKG read boundary.
 */
export const isCanonicalDingTalkIdentityContract = (input: {
  claimMapping: PlatformIdentityProviderClaimMapping;
  scopes: readonly string[];
}): boolean => {
  const canonical = DINGTALK_IDENTITY_PROVIDER_TEMPLATE;
  return (
    sameStringList(input.scopes, canonical.scopes) &&
    PLATFORM_IDENTITY_PROVIDER_CLAIM_MAPPING_KEYS.every((key) =>
      sameStringList(input.claimMapping[key], canonical.claimMapping[key]),
    )
  );
};

/**
 * Whether a kind can assert that the email it reports was verified by the identity provider.
 *
 * `false` means the kind must NOT appear in Better Auth `accountLinking.trustedProviders`:
 * a trusted provider may implicitly link its identity onto an existing account that merely
 * shares an email address. DingTalk usually returns no email at all (we synthesize one) and
 * never asserts verification, so a DingTalk login must never attach to a pre-existing account.
 */
export const identityProviderAssertsVerifiedEmail = (type: PlatformIdentityProviderType): boolean =>
  type !== 'dingtalk';

/**
 * Canonical DingTalk issuer. DingTalk has no per-tenant issuer and no discovery document, so
 * this is a fixed constant rather than administrator input; which organisations may sign in is
 * expressed by the organisation allowlist below, not by the issuer.
 */
export const DINGTALK_IDENTITY_PROVIDER_ISSUER = 'https://login.dingtalk.com';

export const isDingTalkIdentityProviderIssuer = (issuer: string | null | undefined): boolean =>
  issuer === DINGTALK_IDENTITY_PROVIDER_ISSUER;

/**
 * One enterprise permitted to sign in through a DingTalk login method.
 *
 * `corpId` is never typed by hand: the admin launches a DingTalk login from the wizard, picks
 * the organisation in DingTalk's own UI, and the platform captures the `corpId` the token
 * response reports. `label` is a human note (defaulted from the authorizing user's nick).
 */
export interface PlatformIdentityProviderAllowedCorp {
  /** ISO 8601 capture timestamp. */
  addedAt: string;
  /** Admin user id that captured this organisation, when known. */
  addedBy?: string;
  corpId: string;
  label?: string;
}

/** Permissive on charset (DingTalk ids are opaque), strict on length. */
export const DINGTALK_CORP_ID_PATTERN = /^[\w-]{1,64}$/;
export const DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH = 64;
export const DINGTALK_ALLOWED_CORPS_MAX = 200;

export const isValidDingTalkCorpId = (corpId: unknown): corpId is string =>
  typeof corpId === 'string' && DINGTALK_CORP_ID_PATTERN.test(corpId);

/**
 * Fail-closed organisation check. An empty allowlist allows NOBODY (a DingTalk provider with
 * no allowed organisation is not publishable), and a token response without a `corpId` — the
 * `corpid` scope was not granted — is a rejection, never a pass.
 */
export const isDingTalkCorpAllowed = (
  corpId: string | null | undefined,
  allowlist: readonly PlatformIdentityProviderAllowedCorp[],
): boolean => isValidDingTalkCorpId(corpId) && allowlist.some((entry) => entry.corpId === corpId);

/** Runtime parser for allowlists crossing the untrusted persistence boundary. */
export const parseDingTalkAllowedCorps = (
  value: unknown,
): PlatformIdentityProviderAllowedCorp[] | null => {
  if (!Array.isArray(value) || value.length > DINGTALK_ALLOWED_CORPS_MAX) return null;
  const parsed: PlatformIdentityProviderAllowedCorp[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !['addedAt', 'addedBy', 'corpId', 'label'].includes(key)) ||
      !isValidDingTalkCorpId(record.corpId) ||
      seen.has(record.corpId) ||
      typeof record.addedAt !== 'string' ||
      Number.isNaN(Date.parse(record.addedAt)) ||
      (record.addedBy !== undefined &&
        (typeof record.addedBy !== 'string' || !record.addedBy || record.addedBy.length > 128)) ||
      (record.label !== undefined &&
        (typeof record.label !== 'string' ||
          record.label.length > DINGTALK_ALLOWED_CORP_LABEL_MAX_LENGTH))
    ) {
      return null;
    }
    seen.add(record.corpId);
    parsed.push({
      addedAt: record.addedAt,
      ...(record.addedBy === undefined ? {} : { addedBy: record.addedBy as string }),
      corpId: record.corpId,
      ...(record.label === undefined ? {} : { label: record.label as string }),
    });
  }
  return parsed;
};

/**
 * DingTalk → Better Auth callback shim path.
 *
 * DingTalk's 统一登录 returns the authorization code as `authCode`, while Better Auth's
 * generic-OAuth callback reads the OAuth 2.0 `code`. A DingTalk app therefore registers THIS
 * path as its redirect URL, and it is also what the platform puts in the authorization request;
 * the route rewrites the parameter and forwards to `/api/auth/oauth2/callback/<providerKey>`.
 */
export const DINGTALK_LOGIN_CALLBACK_PATH_PREFIX = '/oauth/identity-provider/dingtalk';

/** Redirect URL a DingTalk app must register for `providerKey`. */
export const buildDingTalkLoginCallbackUrl = (origin: string, providerKey: string): string =>
  `${origin.replace(/\/$/, '')}${DINGTALK_LOGIN_CALLBACK_PATH_PREFIX}/${providerKey}`;

/**
 * Reserved, non-resolvable email namespace for identities the platform synthesizes because the
 * identity provider exposes no address. Self-service sign-up is blocked on this namespace
 * (`registrationGuard`) so a local account can never pre-claim a synthetic identity, and each
 * login method gets its own sub-domain so two DingTalk providers cannot collide either.
 */
export const SYNTHETIC_IDENTITY_EMAIL_ROOT_DOMAIN = 'dingtalk.sso';

export const buildDingTalkSyntheticEmail = (providerKey: string, subject: string): string =>
  `${subject}@${providerKey}.${SYNTHETIC_IDENTITY_EMAIL_ROOT_DOMAIN}`;

/**
 * True for any address inside the reserved synthetic namespace (or its root domain).
 *
 * Classified by comparing the whole domain, not by matching label charsets: the sub-domain is a
 * provider key, and any charset assumption here would silently un-reserve part of the namespace
 * the builder can actually emit.
 */
export const isReservedSyntheticIdentityEmail = (email: string | null | undefined): boolean => {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0) return false;
  const domain = trimmed.slice(separator + 1).toLowerCase();
  return (
    domain === SYNTHETIC_IDENTITY_EMAIL_ROOT_DOMAIN ||
    domain.endsWith(`.${SYNTHETIC_IDENTITY_EMAIL_ROOT_DOMAIN}`)
  );
};

/**
 * DingTalk provider keys must additionally be a single DNS label.
 *
 * The generic `providerKey` charset allows `.` and `_`, but this key becomes the sub-domain of
 * the synthesized address (`<unionId>@<providerKey>.dingtalk.sso`). An underscore — or a label
 * starting/ending with `-` — makes that address fail RFC-shaped email validation, which would
 * break every DingTalk login at claim validation rather than at configuration time.
 */
export const DINGTALK_PROVIDER_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isValidDingTalkProviderKey = (providerKey: unknown): providerKey is string =>
  typeof providerKey === 'string' && DINGTALK_PROVIDER_KEY_PATTERN.test(providerKey);

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
  /**
   * Organisations permitted to sign in through this DingTalk login method. Always `[]` for
   * every other kind. Captured through the wizard's DingTalk login, never typed by hand.
   */
  dingtalkAllowedCorps: PlatformIdentityProviderAllowedCorp[];
  displayName: string;
  domainAllowlist: string[];
  enabled: boolean;
  groupRoleMapping: Record<string, string>;
  /**
   * Server-resolved: any published revision exists for this provider (including prior
   * live snapshots after the mutable head forked back to draft). Present on list/get
   * projections; mutation responses may omit it.
   */
  hasPublishedHistory?: boolean;
  icon: string | null;
  id: string;
  issuer: string | null;
  migrationRequired: boolean;
  providerKey: string;
  /**
   * Server-resolved: a successful safe-login test for the current revision is still
   * valid (within publish TTL). Present on list/get so Publish readiness is not
   * ephemeral wizard state only.
   */
  publishTestReady?: boolean;
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
  /**
   * RFC 9207: when true the authorization response must include `iss` equal to the
   * discovered issuer. When false/absent, a present `iss` is still validated exactly.
   */
  authorizationResponseIssParameterSupported: boolean;
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
  // DingTalk profile fields (kind `dingtalk`) — present so its safe-login test previews
  // the same claims the runtime adapter maps.
  'avatarUrl',
  'dingtalk_title',
  'dingtalk_user_id',
  'email',
  'name',
  'nick',
  'openId',
  'picture',
  'preferred_username',
  'sub',
  'unionId',
] as const;

export type PlatformIdentityProviderPreviewClaim =
  (typeof PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS)[number];

export interface PlatformIdentityProviderClaimValidationIssue {
  code: 'email_domain_denied' | 'email_invalid' | 'required_claim_missing';
  field: 'email' | 'name' | 'subject';
}

/**
 * DingTalk capture outcome of a safe-login test. Unlike the claim preview (which reports only
 * presence, never values) these two are the *point* of the test for this kind: the admin runs a
 * DingTalk login precisely to discover the organisation id, and `nick` labels who captured it.
 * Both are non-secret and are shown back to the administrator.
 */
export interface PlatformIdentityProviderDingTalkCapture {
  corpId: string;
  nick?: string;
}

export interface PlatformIdentityProviderClaimPreview {
  claims: Partial<Record<PlatformIdentityProviderPreviewClaim, string>>;
  /** Present only for `dingtalk` safe-login tests. */
  dingtalk?: PlatformIdentityProviderDingTalkCapture;
  issues: PlatformIdentityProviderClaimValidationIssue[];
  valid: boolean;
}
