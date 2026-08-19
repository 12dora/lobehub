import { createHash } from 'node:crypto';

import type { BrowserSessionAcquireInput } from './types';
import { BrowserSessionError } from './types';

const IDENTITY_VERSION = 'v1';

const normalizeOptional = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

/** sha256 hex of any identity material. Safe to put in keys, paths, logs, and metrics. */
export const digestBrowserSessionMaterial = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Drop userinfo / path / query so an origin never carries credentials.
 * Non-URL strings are returned trimmed.
 */
export const normalizeBrowserSessionOrigin = (origin: string): string => {
  const trimmed = origin.trim();
  if (!trimmed) return trimmed;
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.origin;
  } catch {
    return trimmed;
  }
};

export const normalizeBrowserSessionIdentity = (input: {
  accountId: string;
  origin: string;
  provider: string;
}): { accountId: string; origin: string; provider: string } => {
  const provider = input.provider.trim();
  const accountId = input.accountId.trim();
  const origin = normalizeBrowserSessionOrigin(input.origin);

  if (!provider) throw new BrowserSessionError('provider is required');
  if (!accountId) throw new BrowserSessionError('accountId is required');
  if (!origin) throw new BrowserSessionError('origin is required');

  return { accountId, origin, provider };
};

export const normalizeBrowserSessionAcquireInput = (
  input: BrowserSessionAcquireInput,
): Required<
  Pick<BrowserSessionAcquireInput, 'accountId' | 'browserProfileRevision' | 'origin' | 'provider'>
> &
  Pick<
    BrowserSessionAcquireInput,
    | 'credentialDigestInput'
    | 'deviceId'
    | 'ephemeral'
    | 'impersonationProfileRevision'
    | 'ownerId'
    | 'proxyOutlet'
  > => {
  const { accountId, origin, provider } = normalizeBrowserSessionIdentity(input);
  if (!Number.isFinite(input.browserProfileRevision)) {
    throw new BrowserSessionError('browserProfileRevision is required');
  }

  return {
    accountId,
    browserProfileRevision: input.browserProfileRevision,
    credentialDigestInput: normalizeOptional(input.credentialDigestInput),
    deviceId: normalizeOptional(input.deviceId),
    ...(input.ephemeral ? { ephemeral: true } : {}),
    impersonationProfileRevision: normalizeOptional(input.impersonationProfileRevision),
    origin,
    ownerId: normalizeOptional(input.ownerId),
    provider,
    proxyOutlet: normalizeOptional(input.proxyOutlet),
  };
};

/** Reuse key: provider + account + origin. Credential/device/proxy live on the binding. */
export const buildBrowserSessionLookupKey = (params: {
  accountId: string;
  origin: string;
  provider: string;
}): string =>
  digestBrowserSessionMaterial(
    [IDENTITY_VERSION, params.provider, params.accountId, params.origin].join('\0'),
  );

export const buildBrowserSessionBindingDigest = (params: {
  browserProfileRevision: number;
  credentialDigestInput?: string;
  deviceId?: string;
  impersonationProfileRevision?: string;
  proxyOutlet?: string;
}): string => {
  const credentialDigest = params.credentialDigestInput
    ? digestBrowserSessionMaterial(params.credentialDigestInput)
    : '';
  const deviceDigest = params.deviceId ? digestBrowserSessionMaterial(params.deviceId) : '';

  return digestBrowserSessionMaterial(
    [
      IDENTITY_VERSION,
      credentialDigest,
      String(params.browserProfileRevision),
      deviceDigest,
      params.proxyOutlet ?? '',
      params.impersonationProfileRevision ?? '',
    ].join('\0'),
  );
};
