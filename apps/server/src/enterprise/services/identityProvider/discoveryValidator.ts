import type { PlatformOidcDiscoveryMetadata } from '@lobechat/types';

import { oidcDiscoveryMetadataSchema } from '../../contracts/identityProviders';
import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import { SafeOutboundHttpError } from '../../security/outboundHttp';

const DISCOVERY_TIMEOUT_MS = 5000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const DISCOVERY_MAX_REDIRECTS = 2;

export type IdentityProviderValidationErrorCode =
  | 'OIDC_DISCOVERY_INVALID'
  | 'OIDC_DISCOVERY_UNAVAILABLE'
  | 'OIDC_ISSUER_INVALID'
  | 'OIDC_NETWORK_BLOCKED';

export class IdentityProviderValidationError extends Error {
  constructor(public readonly code: IdentityProviderValidationErrorCode) {
    super(code);
    this.name = 'IdentityProviderValidationError';
  }
}

const isJsonContentType = (value: string | null): boolean => {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || mediaType?.endsWith('+json') === true;
};

const canonicalHttpsUrl = (value: string, errorCode: IdentityProviderValidationErrorCode): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IdentityProviderValidationError(errorCode);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    url.hash
  ) {
    throw new IdentityProviderValidationError(errorCode);
  }
  return url;
};

const canonicalIssuer = (value: string): string => {
  const url = canonicalHttpsUrl(value, 'OIDC_ISSUER_INVALID');
  if (url.search) throw new IdentityProviderValidationError('OIDC_ISSUER_INVALID');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
};

const discoveryUrlForIssuer = (issuer: string): string =>
  `${issuer}/.well-known/openid-configuration`;

const toMetadata = (
  parsed: ReturnType<typeof oidcDiscoveryMetadataSchema.parse>,
): PlatformOidcDiscoveryMetadata => ({
  authorizationEndpoint: parsed.authorization_endpoint,
  codeChallengeMethodsSupported: parsed.code_challenge_methods_supported,
  idTokenSigningAlgValuesSupported: parsed.id_token_signing_alg_values_supported,
  issuer: parsed.issuer,
  jwksUri: parsed.jwks_uri,
  responseTypesSupported: parsed.response_types_supported,
  scopesSupported: parsed.scopes_supported,
  subjectTypesSupported: parsed.subject_types_supported,
  tokenEndpoint: parsed.token_endpoint,
  tokenEndpointAuthMethodsSupported:
    parsed.token_endpoint_auth_methods_supported.length > 0
      ? parsed.token_endpoint_auth_methods_supported
      : ['client_secret_basic'],
  userinfoEndpoint: parsed.userinfo_endpoint ?? null,
});

/** OIDC-specific fail-closed facade over the shared DNS-pinned outbound client. */
export class IdentityProviderDiscoveryValidator {
  constructor(private readonly outbound: SafeOutboundHttpClient) {}

  validateNetwork = async (issuerInput: string): Promise<void> => {
    const issuer = canonicalIssuer(issuerInput);
    try {
      await this.outbound.preflight(discoveryUrlForIssuer(issuer));
    } catch (error) {
      if (error instanceof SafeOutboundHttpError) {
        throw new IdentityProviderValidationError('OIDC_NETWORK_BLOCKED');
      }
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_UNAVAILABLE');
    }
  };

  discover = async (issuerInput: string): Promise<PlatformOidcDiscoveryMetadata> => {
    const issuer = canonicalIssuer(issuerInput);
    let response;
    try {
      response = await this.outbound.fetch(discoveryUrlForIssuer(issuer), {
        headers: { Accept: 'application/json' },
        maxRedirects: DISCOVERY_MAX_REDIRECTS,
        maxResponseBytes: DISCOVERY_MAX_BYTES,
        method: 'GET',
        timeoutMs: DISCOVERY_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof SafeOutboundHttpError) {
        throw new IdentityProviderValidationError('OIDC_NETWORK_BLOCKED');
      }
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_UNAVAILABLE');
    }
    if (
      !response.ok ||
      response.truncated ||
      !isJsonContentType(response.headers.get('content-type'))
    ) {
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_INVALID');
    }

    let metadata: PlatformOidcDiscoveryMetadata;
    try {
      metadata = toMetadata(oidcDiscoveryMetadataSchema.parse(await response.json()));
    } catch {
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_INVALID');
    }

    let discoveredIssuer: string;
    try {
      discoveredIssuer = canonicalIssuer(metadata.issuer);
    } catch {
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_INVALID');
    }
    if (
      discoveredIssuer !== issuer ||
      !metadata.responseTypesSupported.includes('code') ||
      !metadata.subjectTypesSupported.some((value) => value === 'public' || value === 'pairwise') ||
      metadata.idTokenSigningAlgValuesSupported.includes('none') ||
      metadata.idTokenSigningAlgValuesSupported.length === 0 ||
      !metadata.codeChallengeMethodsSupported.includes('S256') ||
      !metadata.tokenEndpointAuthMethodsSupported.some(
        (value) => value === 'client_secret_basic' || value === 'client_secret_post',
      )
    ) {
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_INVALID');
    }

    const endpointInputs = [
      metadata.authorizationEndpoint,
      metadata.tokenEndpoint,
      metadata.jwksUri,
      ...(metadata.userinfoEndpoint ? [metadata.userinfoEndpoint] : []),
    ];
    try {
      const endpoints = endpointInputs.map((endpoint) =>
        canonicalHttpsUrl(endpoint, 'OIDC_DISCOVERY_INVALID'),
      );
      await Promise.all(endpoints.map((endpoint) => this.outbound.preflight(endpoint)));
    } catch (error) {
      if (error instanceof IdentityProviderValidationError) throw error;
      if (error instanceof SafeOutboundHttpError) {
        throw new IdentityProviderValidationError('OIDC_NETWORK_BLOCKED');
      }
      throw new IdentityProviderValidationError('OIDC_DISCOVERY_UNAVAILABLE');
    }
    return metadata;
  };
}
