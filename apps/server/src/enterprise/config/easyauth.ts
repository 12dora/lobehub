/**
 * EasyAuth runtime config — reads process.env only.
 * Secrets never logged. Does not use packages/env.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  EASYAUTH_APP_KEY,
  EASYAUTH_DEFAULT_BASE_URL,
  EASYAUTH_DEFAULT_TIMEOUT_MS,
  EASYAUTH_DEFAULT_TOKEN_FILE,
  EASYAUTH_ENV,
} from '@/const/platform/easyauth';

export interface EasyauthRuntimeConfig {
  appKey: string;
  /** Static app token (`eat_…`) — never log this value. */
  appToken: string | null;
  baseUrl: string;
  descriptorToken: string | null;
  manifestSchemaVersion: number;
  portalUrl: string;
  timeoutMs: number;
}

const expandHome = (path: string): string =>
  path.startsWith('~/') ? path.replace('~', homedir()) : path;

/**
 * Read token from env or token file. Returns null when unset.
 * Never throws on missing file — callers degrade gracefully.
 */
export const readEasyauthAppToken = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const direct = env[EASYAUTH_ENV.APP_TOKEN]?.trim();
  if (direct) return direct;

  const filePath = expandHome(
    env[EASYAUTH_ENV.APP_TOKEN_FILE]?.trim() || EASYAUTH_DEFAULT_TOKEN_FILE,
  );
  try {
    const value = readFileSync(filePath, 'utf8').trim();
    return value || null;
  } catch {
    return null;
  }
};

export const parseEasyauthConfig = (
  env: NodeJS.ProcessEnv = process.env,
): EasyauthRuntimeConfig => {
  const baseUrl = (env[EASYAUTH_ENV.BASE_URL] || EASYAUTH_DEFAULT_BASE_URL).replace(/\/$/, '');
  const portalUrl = (env[EASYAUTH_ENV.PORTAL_URL] || baseUrl).replace(/\/$/, '');
  const timeoutRaw = env[EASYAUTH_ENV.TIMEOUT_MS];
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : EASYAUTH_DEFAULT_TIMEOUT_MS;
  const schemaRaw = env[EASYAUTH_ENV.MANIFEST_SCHEMA_VERSION];
  const manifestSchemaVersion = schemaRaw ? Math.max(1, Number(schemaRaw) || 1) : 1;

  return {
    appKey: env[EASYAUTH_ENV.APP_KEY] || EASYAUTH_APP_KEY,
    appToken: readEasyauthAppToken(env),
    baseUrl,
    descriptorToken: env[EASYAUTH_ENV.DESCRIPTOR_TOKEN]?.trim() || null,
    manifestSchemaVersion,
    portalUrl,
    timeoutMs:
      Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : EASYAUTH_DEFAULT_TIMEOUT_MS,
  };
};

/** Redacted view safe for status APIs / logs. */
export const redactEasyauthConfig = (config: EasyauthRuntimeConfig) => ({
  appKey: config.appKey,
  baseUrl: config.baseUrl,
  hasAppToken: Boolean(config.appToken),
  hasDescriptorToken: Boolean(config.descriptorToken),
  manifestSchemaVersion: config.manifestSchemaVersion,
  portalUrl: config.portalUrl,
  timeoutMs: config.timeoutMs,
});
