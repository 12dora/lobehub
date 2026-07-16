/**
 * Client-safe parity implementation of the platform redaction key rules.
 *
 * Fact source: packages/database/src/models/platform/redact.ts. Keep the exact-key and
 * normalized-token sets in parity, without importing the server/database module into the SPA.
 */

const normalizeKey = (key: string): string => key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();

const SENSITIVE_KEY_EXACT = new Set(
  [
    'apikey',
    'apisecret',
    'apitoken',
    'clientsecret',
    'secret',
    'token',
    'password',
    'passwd',
    'authorization',
    'authorizationheader',
    'authheader',
    'cookie',
    'setcookie',
    'keyvault',
    'keyvaults',
    'encryptedkeyvaults',
    'encryptedclientsecret',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'sessiontoken',
    'privatekey',
    'accesskey',
    'accesskeyid',
    'secretaccesskey',
    'awssecretaccesskey',
    'openaiapikey',
    'xapikey',
    'bearer',
    'credential',
    'credentials',
  ].map(normalizeKey),
);

const SENSITIVE_NORMALIZED_TOKENS = [
  'apikey',
  'apisecret',
  'apitoken',
  'clientsecret',
  'secret',
  'token',
  'password',
  'passwd',
  'credential',
  'authorization',
  'cookie',
  'privatekey',
  'accesskey',
  'secretaccesskey',
  'keyvault',
] as const;

const AI_CATALOG_BENIGN_KEYS = new Set(['contextwindowtokens', 'maxtokens']);

export const SENSITIVE_PUBLIC_VALUE_PATTERN =
  /bearer\s+[\w.~+/=-]+|sk-[a-z0-9]{8,}|ghp_[a-z0-9]{20,}|xox[baprs]-[a-z0-9-]{10,}/i;

export const isPublicDraftSensitiveKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true;
  return SENSITIVE_NORMALIZED_TOKENS.some(
    (token) => normalized === token || normalized.endsWith(token) || normalized.includes(token),
  );
};

export const isAiCatalogBenignPublicKey = (key: string): boolean =>
  AI_CATALOG_BENIGN_KEYS.has(normalizeKey(key));

export const isPublicDraftCredentialBearingUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      Boolean(url.username || url.password) ||
      [...url.searchParams.keys()].some(
        (key) => isPublicDraftSensitiveKey(key) && !isAiCatalogBenignPublicKey(key),
      )
    );
  } catch {
    return false;
  }
};

export const containsSensitivePublicDraftValue = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return SENSITIVE_PUBLIC_VALUE_PATTERN.test(value) || isPublicDraftCredentialBearingUrl(value);
  }
  if (Array.isArray(value)) return value.some(containsSensitivePublicDraftValue);
  if (value && typeof value === 'object') {
    return Object.entries(value).some(
      ([key, child]) =>
        (isPublicDraftSensitiveKey(key) && !isAiCatalogBenignPublicKey(key)) ||
        containsSensitivePublicDraftValue(child),
    );
  }
  return false;
};
