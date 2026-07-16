/**
 * EasyAuth integration constants for AIHub (app_key=aihub).
 * Secrets are never defined here — only env var *names* and public keys.
 */

export const EASYAUTH_APP_KEY = 'aihub' as const;

export const EASYAUTH_DESCRIPTOR_PATH = '/.well-known/easyauth-app.json' as const;

export const EASYAUTH_DESCRIPTOR_VERSION = 1 as const;

/** Default public portal for permission requests (overridable via env). */
export const EASYAUTH_DEFAULT_BASE_URL = 'https://iam.jiefakj.com';

/**
 * Runtime env var names (values must come from process.env / secret files).
 * Do NOT put tokens in code, tests, snapshots, docs, or logs.
 */
export const EASYAUTH_ENV = {
  BASE_URL: 'EASYAUTH_BASE_URL',
  APP_KEY: 'EASYAUTH_APP_KEY',
  APP_TOKEN: 'EASYAUTH_APP_TOKEN',
  /** Optional file path whose contents are the static app token (preferred locally). */
  APP_TOKEN_FILE: 'EASYAUTH_APP_TOKEN_FILE',
  TIMEOUT_MS: 'EASYAUTH_TIMEOUT_MS',
  MANIFEST_SCHEMA_VERSION: 'EASYAUTH_MANIFEST_SCHEMA_VERSION',
  /** Public URL used on the "request access" page. */
  PORTAL_URL: 'EASYAUTH_PORTAL_URL',
  /** Optional bearer required to fetch the well-known descriptor. */
  DESCRIPTOR_TOKEN: 'EASYAUTH_DESCRIPTOR_TOKEN',
} as const;

export const EASYAUTH_DEFAULT_TOKEN_FILE =
  '~/.local/share/aihub/secrets/easyauth-aihub-static-token.txt';

export const EASYAUTH_DEFAULT_TIMEOUT_MS = 8_000;
