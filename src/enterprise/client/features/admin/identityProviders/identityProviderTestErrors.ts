import type { PlatformIdentityProviderType } from '@lobechat/types';

/**
 * Safe-login / organisation-capture failures reported by the server as a stable error code.
 * Mapped to admin-facing copy so a DingTalk misconfiguration (wrong AppSecret, redirect URL not
 * registered, `corpid` scope missing) reads as an instruction instead of an opaque code.
 */
// A Map, not an object: codes arrive from the server, and an object lookup would
// resolve inherited members such as `constructor` to a non-key value.
const IDENTITY_PROVIDER_TEST_ERROR_KEYS = new Map<string, string>(
  Object.entries({
    OIDC_TEST_ACCESS_TOKEN_REQUIRED: 'identityProviders.test.errors.accessTokenRequired',
    OIDC_TEST_AUTHORIZATION_FAILED: 'identityProviders.test.errors.authorizationFailed',
    OIDC_TEST_CALLBACK_ORIGIN_INVALID: 'identityProviders.test.errors.callbackOriginInvalid',
    OIDC_TEST_CLAIM_VALIDATION_FAILED: 'identityProviders.test.errors.claimValidationFailed',
    OIDC_TEST_CONFIG_INCOMPLETE: 'identityProviders.test.errors.configIncomplete',
    OIDC_TEST_CORP_ID_MISSING: 'identityProviders.test.errors.corpIdMissing',
    OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN: 'identityProviders.test.errors.dingtalkProfileForbidden',
    OIDC_TEST_DINGTALK_PROFILE_REJECTED: 'identityProviders.test.errors.dingtalkProfileRejected',
    OIDC_TEST_DINGTALK_TOKEN_REJECTED: 'identityProviders.test.errors.dingtalkTokenRejected',
    OIDC_TEST_DISCOVERY_INVALID: 'identityProviders.test.errors.discoveryInvalid',
    OIDC_TEST_DRAFT_REQUIRED: 'identityProviders.workflow.draftRequired',
    OIDC_TEST_ID_TOKEN_INVALID: 'identityProviders.test.errors.idTokenInvalid',
    OIDC_TEST_ISSUER_INVALID: 'identityProviders.test.errors.issuerInvalid',
    OIDC_TEST_NONCE_INVALID: 'identityProviders.test.errors.idTokenInvalid',
    OIDC_TEST_PROVIDER_CHANGED: 'identityProviders.test.errors.providerChanged',
    OIDC_TEST_REMOTE_INVALID: 'identityProviders.test.errors.remoteInvalid',
    OIDC_TEST_REPLAYED: 'identityProviders.test.errors.replayed',
    OIDC_TEST_RESPONSE_ISSUER_INVALID: 'identityProviders.test.errors.responseIssuerInvalid',
    OIDC_TEST_SECRET_UNAVAILABLE: 'identityProviders.test.errors.secretUnavailable',
    OIDC_TEST_SUBJECT_MISMATCH: 'identityProviders.test.errors.subjectMismatch',
    OIDC_TEST_USERINFO_REQUIRED: 'identityProviders.test.errors.userinfoRequired',
  }),
);

/**
 * Terminal attempt error codes are `CODE` or `CODE:<provider error code>` — the optional suffix
 * is the identity provider's own stable token (DingTalk `invalidParameter.idOrSecret.notFound`,
 * `Forbidden.AccessDenied…`), which names the actual fix.
 */
export const parseIdentityProviderTestErrorCode = (
  errorCode: string | null | undefined,
): { base: string | null; providerCode: string | null } => {
  if (!errorCode) return { base: null, providerCode: null };
  const separator = errorCode.indexOf(':');
  return separator === -1
    ? { base: errorCode, providerCode: null }
    : {
        base: errorCode.slice(0, separator),
        providerCode: errorCode.slice(separator + 1) || null,
      };
};

/** Stable error code embedded anywhere in an error payload (`OIDC_TEST_*`). */
export const extractIdentityProviderTestErrorCode = (value: unknown): string | null => {
  const source =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? JSON.stringify(value)
        : '';
  return /\bOIDC_TEST_[A-Z_]+\b/.exec(source)?.[0] ?? null;
};

/** i18n key describing a failed safe-login / capture attempt. */
export const identityProviderTestErrorKey = (errorCode: string | null | undefined): string => {
  const { base } = parseIdentityProviderTestErrorCode(errorCode);
  return (
    (base ? IDENTITY_PROVIDER_TEST_ERROR_KEYS.get(base) : undefined) ??
    'identityProviders.test.errors.generic'
  );
};

/** A DingTalk error code that means "the app was not granted something". */
const isDingTalkPermissionCode = (providerCode: string | null): boolean =>
  providerCode !== null &&
  (providerCode.startsWith('Forbidden.AccessDenied') || providerCode.includes('Permission'));

/**
 * The one thing an administrator actually needs: WHICH permission/scope to switch on, and where.
 *
 * A DingTalk app fails in three configuration-shaped ways, and the DingTalk console calls each
 * of them something different. Naming the exact item (and its English identifier, which is what
 * the console's search box matches) turns a dead end into a two-minute fix.
 *
 * `null` = no specific remedy is known; the caller keeps the generic message plus the raw code.
 */
export const identityProviderTestRemedyKey = (input: {
  errorCode: string | null | undefined;
  type: PlatformIdentityProviderType;
}): string | null => {
  if (input.type !== 'dingtalk') return null;
  const { base, providerCode } = parseIdentityProviderTestErrorCode(input.errorCode);
  switch (base) {
    // 403 is always a permission problem; a permission-shaped code on any other profile
    // failure means the same thing.
    case 'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN': {
      return 'identityProviders.test.remedies.dingtalkContactPermission';
    }
    case 'OIDC_TEST_DINGTALK_PROFILE_REJECTED': {
      return isDingTalkPermissionCode(providerCode)
        ? 'identityProviders.test.remedies.dingtalkContactPermission'
        : null;
    }
    // The profile came back but without the fields the platform requires (unionId above all).
    case 'OIDC_TEST_CLAIM_VALIDATION_FAILED': {
      return 'identityProviders.test.remedies.dingtalkProfileFields';
    }
    case 'OIDC_TEST_CORP_ID_MISSING': {
      return 'identityProviders.test.remedies.dingtalkCorpIdScope';
    }
    case 'OIDC_TEST_DINGTALK_TOKEN_REJECTED': {
      return providerCode?.includes('idOrSecret')
        ? 'identityProviders.test.remedies.dingtalkCredentials'
        : null;
    }
    default: {
      return null;
    }
  }
};

/**
 * Full admin-facing failure text: what went wrong, exactly what to switch on, and the identity
 * provider's own error code when it reported one.
 */
export const buildIdentityProviderTestFailureMessage = (
  input: {
    errorCode: string | null | undefined;
    type: PlatformIdentityProviderType;
  },
  translate: (key: string, options?: Record<string, unknown>) => string,
): string => {
  const { providerCode } = parseIdentityProviderTestErrorCode(input.errorCode);
  const remedyKey = identityProviderTestRemedyKey(input);
  return [
    translate(identityProviderTestErrorKey(input.errorCode)),
    remedyKey ? translate(remedyKey) : null,
    providerCode
      ? translate('identityProviders.test.errors.providerCode', { code: providerCode })
      : null,
  ]
    .filter(Boolean)
    .join(' ');
};
