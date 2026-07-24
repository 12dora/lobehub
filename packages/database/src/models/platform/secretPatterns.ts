/**
 * Shared secret-shape patterns and sensitive exact-key list used by:
 * - write-path redaction (`redact.ts`)
 * - read-path credential masking (`auditCredentialMask.ts`)
 *
 * Keep both consumers on this single source so new credential forms stay in sync.
 */

/** Strip non-alphanumerics and lowercase for key comparison (accessToken → accesstoken). */
export const normalizeSecretKey = (key: string): string =>
  key.replaceAll(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Normalized forms of known sensitive / credential object keys.
 * Shared by write-path `isSensitiveKey` and read-path exact credential matching.
 */
export const SENSITIVE_KEY_EXACT_NAMES = [
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
] as const;

export const SENSITIVE_KEY_EXACT = new Set(
  SENSITIVE_KEY_EXACT_NAMES.map((name) => normalizeSecretKey(name)),
);

/**
 * Prefixed vendor tokens / API keys (GitHub token families, OpenAI-style sk-, Slack xox*).
 * Detection variant (no `g`) for `.test()`; global for `.replaceAll()`.
 *
 * GitHub families (docs): ghp_ classic PAT, github_pat_ fine-grained PAT,
 * gho_ OAuth, ghu_ user-to-server, ghs_ server-to-server, ghr_ refresh.
 */
export const PREFIXED_SECRET_PATTERN =
  /(?<![\w-])(?:gh[pousr]_[a-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{19,}[a-z0-9]|xox[baprs]-[a-z0-9-]{10,})(?![\w-])/iu;
export const PREFIXED_SECRET_GLOBAL =
  /(?<![\w-])(?:gh[pousr]_[a-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{19,}[a-z0-9]|xox[baprs]-[a-z0-9-]{10,})(?![\w-])/giu;

/** Compact JWT shape. */
export const JWT_PATTERN = /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}(?![\w-])/iu;
export const JWT_GLOBAL = /(?<![\w-])eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}(?![\w-])/gu;

/** AWS access key id (AKIA/ASIA). */
export const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/;
export const AWS_ACCESS_KEY_GLOBAL = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;

/** Google API key prefix. */
export const GCP_API_KEY_PATTERN = /\bAIza[\w-]{35}\b/;
export const GCP_API_KEY_GLOBAL = /\bAIza[\w-]{35}\b/g;

/** PEM private key block (full block for replace; prefix-only ok for detect). */
export const PEM_PRIVATE_KEY_DETECT = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
export const PEM_PRIVATE_KEY_GLOBAL =
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g;
