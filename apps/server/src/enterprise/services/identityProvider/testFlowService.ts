import { timingSafeEqual } from 'node:crypto';

import {
  OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS,
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  type PlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderClaimPreview,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import { decodeProtectedHeader, importJWK, type JWK, type JWTPayload, jwtVerify } from 'jose';
import { z } from 'zod';

import { PlatformIdentityProviderModel } from '@/database/models/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import type { PlatformSecretService } from '../../security/secret';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderSecretStore } from './secretStore';
import {
  hashIdentityProviderTestValue,
  IdentityProviderTestAttemptStore,
} from './testAttemptStore';

const TOKEN_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;

const tokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(32_768).optional(),
    id_token: z.string().min(1).max(32_768),
    token_type: z.string().max(64).optional(),
  })
  .passthrough();

const jwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(64) });

const safeJson = async (response: Awaited<ReturnType<SafeOutboundHttpClient['fetch']>>) => {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    !response.ok ||
    response.truncated ||
    (contentType !== 'application/json' && !contentType?.endsWith('+json'))
  ) {
    throw new Error('OIDC_TEST_REMOTE_INVALID');
  }
  return response.json();
};

const firstClaim = (claims: Record<string, unknown>, candidates: string[]): string | undefined => {
  for (const candidate of candidates) {
    const value = claims[candidate];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 4096);
  }
};

export const buildIdentityProviderClaimPreview = (
  claims: Record<string, unknown>,
  mapping: PlatformIdentityProviderClaimMapping,
): PlatformIdentityProviderClaimPreview => {
  const previewClaims: PlatformIdentityProviderClaimPreview['claims'] = {};
  for (const key of PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS) {
    const value = claims[key];
    if (typeof value === 'string' && value.trim()) previewClaims[key] = value.trim().slice(0, 4096);
  }
  const issues: PlatformIdentityProviderClaimPreview['issues'] = [];
  if (!firstClaim(claims, mapping.subject))
    issues.push({ code: 'required_claim_missing', field: 'subject' });
  if (!firstClaim(claims, mapping.name))
    issues.push({ code: 'required_claim_missing', field: 'name' });
  return { claims: previewClaims, issues, valid: issues.length === 0 };
};

const assertNonce = (payload: JWTPayload, expectedHash: string) => {
  if (typeof payload.nonce !== 'string') throw new Error('OIDC_TEST_NONCE_INVALID');
  const actual = Buffer.from(hashIdentityProviderTestValue(payload.nonce), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('OIDC_TEST_NONCE_INVALID');
  }
};

/** Independent OIDC draft test flow. It never calls Better Auth or writes user/link records. */
export class IdentityProviderTestFlowService {
  private readonly attempts: IdentityProviderTestAttemptStore;

  constructor(
    private readonly db: LobeChatDatabase,
    secretService: PlatformSecretService,
    private readonly discovery: IdentityProviderDiscoveryValidator,
    private readonly outbound: SafeOutboundHttpClient,
  ) {
    this.attempts = new IdentityProviderTestAttemptStore(db, secretService);
    this.secretStore = new IdentityProviderSecretStore(db, secretService);
  }

  private readonly secretStore: IdentityProviderSecretStore;

  start = async (input: {
    expectedRevision: number;
    id: string;
    redirectUri: string;
    sessionId: string;
    userId: string;
  }) => {
    const provider = await new PlatformIdentityProviderModel(this.db).get(input.id);
    if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    if (provider.migrationRequired || provider.status !== 'draft')
      throw new Error('OIDC_TEST_DRAFT_REQUIRED');
    if (provider.revision !== input.expectedRevision) throw new Error('PLATFORM_REVISION_CONFLICT');
    if (!provider.issuer || !provider.clientId || !provider.secret.configured) {
      throw new Error('OIDC_TEST_CONFIG_INCOMPLETE');
    }
    const metadata = await this.discovery.discover(provider.issuer);
    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    const reserved = [
      'client_id',
      'code_challenge',
      'code_challenge_method',
      'nonce',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ];
    if (reserved.some((key) => authorizationUrl.searchParams.has(key))) {
      throw new Error('OIDC_TEST_DISCOVERY_INVALID');
    }
    const attempt = await this.attempts.issue({
      providerId: provider.id,
      providerRevision: provider.revision,
      redirectUri: input.redirectUri,
      sessionId: input.sessionId,
      userId: input.userId,
    });
    authorizationUrl.searchParams.set('client_id', provider.clientId);
    authorizationUrl.searchParams.set('code_challenge', attempt.codeChallenge);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('nonce', attempt.nonce);
    authorizationUrl.searchParams.set('redirect_uri', input.redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
    authorizationUrl.searchParams.set('state', attempt.state);
    return {
      attemptId: attempt.attemptId,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: attempt.expiresAt,
    };
  };

  callback = async (input: {
    code: string;
    state: string;
  }): Promise<{ attemptId: string; valid: boolean }> => {
    const attempt = await this.attempts.reserve(input.state);
    try {
      const provider = await new PlatformIdentityProviderModel(this.db).get(attempt.providerId);
      if (
        !provider ||
        provider.status !== 'draft' ||
        provider.migrationRequired ||
        provider.revision !== attempt.providerRevision ||
        !provider.issuer ||
        !provider.clientId
      ) {
        throw new Error('OIDC_TEST_PROVIDER_CHANGED');
      }
      const metadata = await this.discovery.discover(provider.issuer);
      const secret = await this.secretStore.resolveCurrentClientSecret(provider.id);
      if (!secret) throw new Error('OIDC_TEST_SECRET_UNAVAILABLE');
      const token = await this.exchangeCode({
        clientId: provider.clientId,
        clientSecret: secret,
        code: input.code,
        metadata,
        pkceVerifier: attempt.pkceVerifier,
        redirectUri: attempt.redirectUri,
      });
      const idClaims = await this.verifyIdToken({
        clientId: provider.clientId,
        idToken: token.id_token,
        metadata,
        nonceHash: attempt.nonceHash,
      });
      let claims: Record<string, unknown> = { ...idClaims };
      if (metadata.userinfoEndpoint && token.access_token) {
        const userinfo = z.record(z.string(), z.unknown()).parse(
          await safeJson(
            await this.outbound.fetch(metadata.userinfoEndpoint, {
              headers: { Authorization: `Bearer ${token.access_token}` },
              maxRedirects: 0,
              maxResponseBytes: TOKEN_MAX_BYTES,
              method: 'GET',
              secretBearing: true,
              timeoutMs: TOKEN_TIMEOUT_MS,
            }),
          ),
        );
        if (userinfo.sub !== idClaims.sub) throw new Error('OIDC_TEST_SUBJECT_MISMATCH');
        claims = { ...idClaims, ...userinfo };
      }
      const preview = buildIdentityProviderClaimPreview(claims, provider.claimMapping);
      const current = await new PlatformIdentityProviderModel(this.db).get(provider.id);
      if (
        !current ||
        current.revision !== attempt.providerRevision ||
        current.status !== 'draft' ||
        current.migrationRequired
      ) {
        throw new Error('OIDC_TEST_PROVIDER_CHANGED');
      }
      await this.attempts.succeed(attempt.id, preview);
      return { attemptId: attempt.id, valid: preview.valid };
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
          ? error.message
          : 'OIDC_TEST_FAILED';
      await this.attempts.fail(attempt.id, code);
      throw error;
    }
  };

  abandon = async (state: string): Promise<void> => {
    const attempt = await this.attempts.reserve(state);
    await this.attempts.fail(attempt.id, 'OIDC_TEST_AUTHORIZATION_FAILED');
  };

  result = async (input: { attemptId: string; sessionId: string; userId: string }) => {
    const result = await this.attempts.getResult(input);
    if (!result) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    return result;
  };

  private exchangeCode = async (input: {
    clientId: string;
    clientSecret: string;
    code: string;
    metadata: PlatformOidcDiscoveryMetadata;
    pkceVerifier: string;
    redirectUri: string;
  }) => {
    const body = new URLSearchParams({
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.pkceVerifier,
      grant_type: 'authorization_code',
      redirect_uri: input.redirectUri,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (input.metadata.tokenEndpointAuthMethodsSupported.includes('client_secret_basic')) {
      headers.Authorization = `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_secret', input.clientSecret);
    }
    return tokenResponseSchema.parse(
      await safeJson(
        await this.outbound.fetch(input.metadata.tokenEndpoint, {
          body: body.toString(),
          headers,
          maxRedirects: 0,
          maxResponseBytes: TOKEN_MAX_BYTES,
          method: 'POST',
          secretBearing: true,
          timeoutMs: TOKEN_TIMEOUT_MS,
        }),
      ),
    );
  };

  private verifyIdToken = async (input: {
    clientId: string;
    idToken: string;
    metadata: PlatformOidcDiscoveryMetadata;
    nonceHash: string;
  }): Promise<JWTPayload> => {
    const header = decodeProtectedHeader(input.idToken);
    if (
      !header.alg ||
      !OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS.includes(
        header.alg as (typeof OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS)[number],
      )
    ) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    const jwks = jwksSchema.parse(
      await safeJson(
        await this.outbound.fetch(input.metadata.jwksUri, {
          headers: { Accept: 'application/json' },
          maxRedirects: 0,
          maxResponseBytes: TOKEN_MAX_BYTES,
          method: 'GET',
          timeoutMs: TOKEN_TIMEOUT_MS,
        }),
      ),
    );
    const candidate = jwks.keys.find(
      (key) => (!header.kid || key.kid === header.kid) && (!key.alg || key.alg === header.alg),
    );
    if (!candidate) throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    const key = await importJWK(candidate as JWK, header.alg);
    const { payload } = await jwtVerify(input.idToken, key, {
      algorithms: [header.alg],
      audience: input.clientId,
      issuer: input.metadata.issuer,
    });
    assertNonce(payload, input.nonceHash);
    if (typeof payload.sub !== 'string' || !payload.sub)
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    return payload;
  };
}
