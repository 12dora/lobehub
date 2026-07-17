import { appEnv } from '@/envs/app';

import { PlatformConnectorContractError } from './errors';

export type ConnectorAppUrlProvider = () => string | undefined;

/** Canonical public URL, including the appEnv Vercel/preview/local fallbacks. */
export const canonicalConnectorAppUrlProvider: ConnectorAppUrlProvider = () => appEnv.APP_URL;

export const resolveConnectorCallbackRedirectUri = (
  appUrlProvider: ConnectorAppUrlProvider = canonicalConnectorAppUrlProvider,
): string => {
  const appUrl = appUrlProvider()?.trim();
  if (!appUrl) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
  try {
    const parsed = new URL(appUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('invalid app URL');
    }
    return new URL('/oauth/connector/callback', parsed).toString();
  } catch {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
  }
};
