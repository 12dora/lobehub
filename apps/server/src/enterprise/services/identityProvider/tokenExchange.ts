import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';
import { z } from 'zod';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';

const TOKEN_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768).optional(),
    expires_in: z.number().int().nonnegative().optional(),
    id_token: z.string().min(1).max(32_768),
    refresh_token: z.string().min(1).max(32_768).optional(),
    scope: z.string().max(4096).optional(),
    token_type: z.string().max(64).optional(),
  })
  .passthrough();

export type PlatformOidcTokenResponse = z.infer<typeof tokenResponseSchema>;

const encodeFormCredential = (value: string): string =>
  new URLSearchParams({ value }).toString().slice('value='.length);

export const createClientSecretBasicAuthorization = (clientId: string, clientSecret: string) =>
  `Basic ${Buffer.from(`${encodeFormCredential(clientId)}:${encodeFormCredential(clientSecret)}`).toString('base64')}`;

const failure = (code: string, cause?: unknown): Error =>
  new Error(code, cause === undefined ? undefined : { cause });

export const exchangePlatformOidcAuthorizationCode = async (input: {
  clientId: string;
  clientSecret: string;
  code: string;
  errorCode?: string;
  expectedRedirectUri: string;
  metadata: PlatformOidcDiscoveryMetadata;
  outbound: SafeOutboundHttpClient;
  pkceVerifier: string | undefined;
  redirectUri: string | undefined;
}): Promise<PlatformOidcTokenResponse> => {
  const errorCode = input.errorCode ?? 'PLATFORM_OIDC_TOKEN_RESPONSE_INVALID';
  const pkceVerifier = input.pkceVerifier;
  if (!pkceVerifier || input.redirectUri !== input.expectedRedirectUri) throw failure(errorCode);

  const body = new URLSearchParams({
    code: input.code,
    code_verifier: pkceVerifier,
    grant_type: 'authorization_code',
    redirect_uri: input.expectedRedirectUri,
  });
  const headers: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  if (input.metadata.tokenEndpointAuthMethodsSupported.includes('client_secret_basic')) {
    headers.Authorization = createClientSecretBasicAuthorization(
      input.clientId,
      input.clientSecret,
    );
  } else if (input.metadata.tokenEndpointAuthMethodsSupported.includes('client_secret_post')) {
    body.set('client_id', input.clientId);
    body.set('client_secret', input.clientSecret);
  } else {
    throw failure(errorCode);
  }

  try {
    const response = await input.outbound.fetch(input.metadata.tokenEndpoint, {
      body: body.toString(),
      headers,
      maxRedirects: 0,
      maxResponseBytes: TOKEN_MAX_BYTES,
      method: 'POST',
      secretBearing: true,
      timeoutMs: TOKEN_TIMEOUT_MS,
    });
    const contentType = response.headers
      .get('content-type')
      ?.split(';', 1)[0]
      ?.trim()
      .toLowerCase();
    if (
      !response.ok ||
      response.truncated ||
      (contentType !== 'application/json' && !contentType?.endsWith('+json'))
    ) {
      throw failure(errorCode);
    }
    return tokenResponseSchema.parse(await response.json());
  } catch (error) {
    if (error instanceof Error && error.message === errorCode) throw error;
    throw failure(errorCode, error);
  }
};
