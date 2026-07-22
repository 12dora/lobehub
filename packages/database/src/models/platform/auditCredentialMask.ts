/**
 * Narrow credential-only sanitizer for admin audit conversation / message evidence.
 *
 * Masks passwords, API keys, bearer/OAuth tokens, secrets, key-vault material, and
 * signed-URL auth params. Ordinary PII and business text are preserved without
 * length truncation or generic summarization.
 *
 * Key matching is intentionally stricter than write-path `isSensitiveKey` (which
 * uses broad substring tokens like "token"/"secret") so ordinary business fields
 * such as `tokenCount` or `tokenizer` are not wiped.
 */

import { REDACTED_PLACEHOLDER, redactSensitive } from './redact';

const REDACTED = REDACTED_PLACEHOLDER;

const EASYAUTH_APP_TOKEN = /(?<![\w-])eat_(?:live|test)_[\w-]{15,}[a-z0-9](?![\w-])/giu;
const PREFIXED_SECRET =
  /(?<![\w-])(?:ghp_[a-z0-9]{20,}|sk-[\w-]{19,}[a-z0-9]|xox[baprs]-[a-z0-9-]{10,})(?![\w-])/giu;
const JWT = /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}(?![\w-])/gu;
const BEARER = /\b(bearer)\s+([\w.~+/-]{8,})/giu;
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const GCP_API_KEY = /\bAIza[\w-]{35}\b/g;
const PEM_PRIVATE_KEY =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
// Bare values stop at query/fragment delimiters so `token=…&name=report` does not
// swallow the rest of a URL (signed-URL param masking runs afterward).
const INLINE_ASSIGNMENT =
  /\b(api[-_ ]?key|api[-_ ]?secret|api[-_ ]?token|access[-_ ]?token|authorization|client[-_ ]?secret|credential|id[-_ ]?token|password|passwd|private[-_ ]?key|refresh[-_ ]?token|secret[-_ ]?access[-_ ]?key|token)\s*([:=])\s*(?:"([^"]+)"|'([^']+)'|([^\s,;"'&#]+))/giu;

/** Signed-URL / cloud auth query param names (case-insensitive). */
const SIGNED_URL_AUTH_KEYS = new Set([
  'signature',
  'sig',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token',
  'x-goog-signature',
  'x-ms-signature',
  'ocp-apim-subscription-key',
  'subscription-key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'key',
]);

const normalizeKey = (key: string): string => key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Exact credential object keys (normalized). Short tokens like `token`/`secret`
 * only match exact keys, not business compounds such as `tokenCount`.
 */
const CREDENTIAL_KEY_EXACT = new Set(
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

/**
 * Credential compound suffixes only (openaiApiKey → openaiapikey ends with apikey).
 * Avoids free-substring matches that wipe `tokenizer` / `tokenCount`.
 */
const CREDENTIAL_KEY_SUFFIXES = [
  'apikey',
  'apisecret',
  'apitoken',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'privatekey',
  'secretaccesskey',
  'password',
  'passwd',
  'keyvault',
  'keyvaults',
  'authorization',
  'credential',
  'credentials',
  // Suffix-only (not free substring): authToken → yes; tokenCount/tokenizer → no.
  'token',
  'secret',
] as const;

/** True when the object key itself names credential material. */
export const isCredentialKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (CREDENTIAL_KEY_EXACT.has(normalized)) return true;
  for (const suffix of CREDENTIAL_KEY_SUFFIXES) {
    if (normalized !== suffix && normalized.endsWith(suffix)) return true;
  }
  return false;
};

const maskSignedUrlAuthParams = (value: string): string => {
  // Fast path: no query string.
  if (!value.includes('?') && !value.includes('&')) return value;

  return value.replaceAll(
    /([?&])([^=&#\s]+)=([^&#\s]*)/g,
    (full, sep: string, rawKey: string, _rawVal: string) => {
      const key = decodeURIComponent(rawKey).toLowerCase();
      if (SIGNED_URL_AUTH_KEYS.has(key) || SIGNED_URL_AUTH_KEYS.has(key.replaceAll('_', '-'))) {
        return `${sep}${rawKey}=${REDACTED}`;
      }
      return full;
    },
  );
};

/**
 * Mask credential substrings inside free text. Non-credential content is unchanged
 * (including length and ordinary business / PII text).
 */
export const maskCredentialsInText = (value: string): string => {
  if (!value) return value;

  let out = value;
  out = out.replaceAll(PEM_PRIVATE_KEY, REDACTED);
  out = out.replaceAll(EASYAUTH_APP_TOKEN, REDACTED);
  out = out.replaceAll(PREFIXED_SECRET, REDACTED);
  out = out.replaceAll(JWT, REDACTED);
  out = out.replaceAll(AWS_ACCESS_KEY, REDACTED);
  out = out.replaceAll(GCP_API_KEY, REDACTED);
  out = out.replaceAll(BEARER, (_m, label: string) => `${label} ${REDACTED}`);
  out = out.replaceAll(
    INLINE_ASSIGNMENT,
    (_m, label: string, op: string, d1?: string, d2?: string, bare?: string) => {
      const assigned = d1 ?? d2 ?? bare ?? '';
      if (!assigned || assigned === REDACTED) return _m;
      const quote = d1 != null ? '"' : d2 != null ? "'" : '';
      return `${label}${op}${quote ? `${quote}${REDACTED}${quote}` : REDACTED}`;
    },
  );
  out = maskSignedUrlAuthParams(out);
  return out;
};

/**
 * Deep mask credentials for structured message evidence (editorData, metadata, etc.).
 * Credential keys are fully redacted; string leaves are credential-masked only.
 * Non-credential keys and ordinary business values are preserved.
 */
export const maskCredentialsDeep = <T>(input: T): T => {
  const walk = (value: unknown): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return maskCredentialsInText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (isCredentialKey(key)) {
          out[key] = REDACTED;
          continue;
        }
        out[key] = walk(child);
      }
      return out;
    }
    return value;
  };
  return walk(input) as T;
};

/**
 * Credential-only projection for audit conversation bodies.
 * Uses deep key+value credential masking (not generic PII redaction profiles).
 */
export const maskAuditConversationEvidence = <T>(input: T): T => maskCredentialsDeep(input);

/**
 * Re-export write-path redactor for callers that need structured secret stripping
 * (operation log append path). Not used for conversation body read projections.
 */
export { redactSensitive };
