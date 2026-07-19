import { timingSafeEqual } from 'node:crypto';

import {
  OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS,
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  type PlatformIdentityProviderClaimMapping,
  type PlatformIdentityProviderClaimPreview,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import { and, eq } from 'drizzle-orm';
import { decodeProtectedHeader, importJWK, type JWK, type JWTPayload, jwtVerify } from 'jose';
import { z } from 'zod';

import { PlatformIdentityProviderModel } from '@/database/models/platform';
import { platformIdentityProviders } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import type { PlatformSecretService } from '../../security/secret';
import { PlatformAuditService } from '../platformAudit';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderSecretStore } from './secretStore';
import {
  hashIdentityProviderTestValue,
  IdentityProviderTestAttemptStore,
} from './testAttemptStore';

const TOKEN_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;
const ID_TOKEN_MAX_AGE_SECONDS = 10 * 60;
const ID_TOKEN_MAX_LIFETIME_SECONDS = 60 * 60;
const ID_TOKEN_CLOCK_TOLERANCE_SECONDS = 60;

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

const failureCategory = (error: unknown): string => {
  if (!(error instanceof Error)) return 'oidc_test_failed';
  if (error.message.includes('NOT_FOUND')) return 'not_found';
  if (error.message.includes('CALLBACK_ORIGIN')) return 'callback_origin_invalid';
  if (error.message.includes('PROVIDER_CHANGED')) return 'provider_changed';
  if (error.message.includes('CLAIM')) return 'claim_validation_failed';
  if (error.message.includes('NONCE') || error.message.includes('ID_TOKEN')) {
    return 'id_token_validation_failed';
  }
  if (error.message.includes('SECRET')) return 'secret_unavailable';
  if (error.message.includes('REMOTE') || error.message.includes('DISCOVERY')) {
    return 'remote_validation_failed';
  }
  return 'oidc_test_failed';
};

const encodeFormCredential = (value: string): string =>
  new URLSearchParams({ value }).toString().slice('value='.length);

export const createClientSecretBasicAuthorization = (clientId: string, clientSecret: string) =>
  `Basic ${Buffer.from(`${encodeFormCredential(clientId)}:${encodeFormCredential(clientSecret)}`).toString('base64')}`;

export const assertIdentityProviderAttemptCallbackOrigin = (
  redirectUri: string,
  effectiveOrigin: string,
): void => {
  if (new URL(redirectUri).origin !== effectiveOrigin) {
    throw new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  }
};

export const verifyIdentityProviderIdToken = async (input: {
  clientId: string;
  idToken: string;
  metadata: PlatformOidcDiscoveryMetadata;
  nonceHash: string;
  outbound: SafeOutboundHttpClient;
}): Promise<JWTPayload> => {
  try {
    const header = decodeProtectedHeader(input.idToken);
    if (
      !header.alg ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      !OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS.includes(
        header.alg as (typeof OIDC_ALLOWED_ID_TOKEN_SIGNING_ALGORITHMS)[number],
      ) ||
      !input.metadata.idTokenSigningAlgValuesSupported.includes(header.alg)
    ) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    const jwks = jwksSchema.parse(
      await safeJson(
        await input.outbound.fetch(input.metadata.jwksUri, {
          headers: { Accept: 'application/json' },
          maxRedirects: 0,
          maxResponseBytes: TOKEN_MAX_BYTES,
          method: 'GET',
          timeoutMs: TOKEN_TIMEOUT_MS,
        }),
      ),
    );
    const kidMatches = jwks.keys.filter((key) => key.kid === header.kid);
    if (kidMatches.length !== 1) throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    const candidate = kidMatches[0]!;
    if (candidate.alg !== undefined && candidate.alg !== header.alg) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    const key = await importJWK(candidate as JWK, header.alg);
    const { payload } = await jwtVerify(input.idToken, key, {
      algorithms: [header.alg],
      audience: input.clientId,
      clockTolerance: ID_TOKEN_CLOCK_TOLERANCE_SECONDS,
      issuer: input.metadata.issuer,
    });
    const now = Math.floor(Date.now() / 1000);
    if (
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat! > now + ID_TOKEN_CLOCK_TOLERANCE_SECONDS ||
      now - payload.iat! > ID_TOKEN_MAX_AGE_SECONDS ||
      payload.exp! <= payload.iat! ||
      payload.exp! - payload.iat! > ID_TOKEN_MAX_LIFETIME_SECONDS
    ) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (audiences.some((audience) => typeof audience !== 'string') || audiences.length === 0) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    if (
      (payload.azp !== undefined && payload.azp !== input.clientId) ||
      (audiences.length > 1 && payload.azp !== input.clientId)
    ) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    assertNonce(payload, input.nonceHash);
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new Error('OIDC_TEST_ID_TOKEN_INVALID');
    }
    return payload;
  } catch (error) {
    if (error instanceof Error && error.message === 'OIDC_TEST_NONCE_INVALID') throw error;
    throw new Error('OIDC_TEST_ID_TOKEN_INVALID', { cause: error });
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

  private appendAudit = async (input: {
    action: string;
    actorUserId: string;
    category?: string;
    reason: string;
    result: 'denied' | 'failure' | 'success';
    targetId: string;
  }): Promise<void> => {
    await new PlatformAuditService(this.db).append({
      action: input.action,
      actorUserId: input.actorUserId,
      afterDiff: input.category ? { category: input.category } : null,
      reason: input.reason,
      result: input.result,
      targetId: input.targetId,
      targetType: 'identity_provider_test',
    });
  };

  private appendFailureAudit = async (input: {
    action: string;
    actorUserId: string;
    error: unknown;
    reason: string;
    targetId: string;
  }): Promise<void> => {
    try {
      await this.appendAudit({
        action: input.action,
        actorUserId: input.actorUserId,
        category: failureCategory(input.error),
        reason: input.reason,
        result: 'failure',
        targetId: input.targetId,
      });
    } catch (auditError) {
      console.error('[identityProviderTest] failure audit unavailable', {
        action: input.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private appendAuditBestEffort = async (
    input: Parameters<IdentityProviderTestFlowService['appendAudit']>[0],
  ): Promise<void> => {
    try {
      await this.appendAudit(input);
    } catch (auditError) {
      console.error('[identityProviderTest] terminal audit unavailable', {
        action: input.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  start = async (input: {
    expectedRevision: number;
    id: string;
    reason: string;
    redirectUri: string;
    sessionId: string;
    userId: string;
  }) => {
    try {
      const provider = await new PlatformIdentityProviderModel(this.db).get(input.id);
      if (!provider) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
      if (provider.migrationRequired || provider.status !== 'draft')
        throw new Error('OIDC_TEST_DRAFT_REQUIRED');
      if (provider.revision !== input.expectedRevision)
        throw new Error('PLATFORM_REVISION_CONFLICT');
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
      const [binding] = await this.db
        .select({
          fingerprint: platformIdentityProviders.secretFingerprint,
          ref: platformIdentityProviders.secretRef,
        })
        .from(platformIdentityProviders)
        .where(
          and(
            eq(platformIdentityProviders.id, provider.id),
            eq(platformIdentityProviders.revision, provider.revision),
            eq(platformIdentityProviders.status, 'draft'),
            eq(platformIdentityProviders.migrationRequired, false),
          ),
        )
        .limit(1);
      if (!binding?.ref || !binding.fingerprint) throw new Error('OIDC_TEST_PROVIDER_CHANGED');
      const attempt = await this.attempts.issue({
        auditReason: input.reason,
        providerId: provider.id,
        providerRevision: provider.revision,
        providerSecretFingerprint: binding.fingerprint,
        providerSecretRef: binding.ref,
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
      await this.appendAuditBestEffort({
        action: 'admin.identityProviders.testStart',
        actorUserId: input.userId,
        reason: input.reason,
        result: 'success',
        targetId: attempt.attemptId,
      });
      return {
        attemptId: attempt.attemptId,
        authorizationUrl: authorizationUrl.toString(),
        expiresAt: attempt.expiresAt,
      };
    } catch (error) {
      await this.appendFailureAudit({
        action: 'admin.identityProviders.testStart',
        actorUserId: input.userId,
        error,
        reason: input.reason,
        targetId: input.id,
      });
      throw error;
    }
  };

  callback = async (input: {
    code: string;
    effectiveOrigin: string;
    state: string;
  }): Promise<{ attemptId: string; valid: boolean }> => {
    const attempt = await this.attempts.reserve(input.state);
    try {
      assertIdentityProviderAttemptCallbackOrigin(attempt.redirectUri, input.effectiveOrigin);
      const provider = await new PlatformIdentityProviderModel(this.db).get(attempt.providerId);
      if (
        !provider ||
        provider.status !== 'draft' ||
        provider.migrationRequired ||
        provider.revision !== attempt.providerRevision ||
        provider.secret.fingerprint !== attempt.providerSecretFingerprint ||
        !provider.issuer ||
        !provider.clientId
      ) {
        throw new Error('OIDC_TEST_PROVIDER_CHANGED');
      }
      const metadata = await this.discovery.discover(provider.issuer);
      const [currentBinding] = await this.db
        .select({
          fingerprint: platformIdentityProviders.secretFingerprint,
          ref: platformIdentityProviders.secretRef,
        })
        .from(platformIdentityProviders)
        .where(
          and(
            eq(platformIdentityProviders.id, provider.id),
            eq(platformIdentityProviders.revision, attempt.providerRevision),
            eq(platformIdentityProviders.secretRef, attempt.providerSecretRef),
            eq(platformIdentityProviders.secretFingerprint, attempt.providerSecretFingerprint),
          ),
        )
        .limit(1);
      if (!currentBinding) throw new Error('OIDC_TEST_PROVIDER_CHANGED');
      const secret = await this.secretStore.resolveClientSecretVersion(
        provider.id,
        attempt.providerSecretFingerprint,
      );
      if (!secret) throw new Error('OIDC_TEST_SECRET_UNAVAILABLE');
      const token = await this.exchangeCode({
        clientId: provider.clientId,
        clientSecret: secret,
        code: input.code,
        metadata,
        pkceVerifier: attempt.pkceVerifier,
        redirectUri: attempt.redirectUri,
      });
      const idClaims = await verifyIdentityProviderIdToken({
        clientId: provider.clientId,
        idToken: token.id_token,
        metadata,
        nonceHash: attempt.nonceHash,
        outbound: this.outbound,
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
      await this.attempts.succeed(attempt, preview);
      await this.appendAuditBestEffort({
        action: 'admin.identityProviders.testTerminal',
        actorUserId: attempt.userId,
        category: preview.valid ? undefined : 'claim_validation_rejected',
        reason: attempt.auditReason,
        result: preview.valid ? 'success' : 'denied',
        targetId: attempt.id,
      });
      return { attemptId: attempt.id, valid: preview.valid };
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
          ? error.message
          : 'OIDC_TEST_FAILED';
      await this.attempts.fail(attempt.id, code);
      await this.appendFailureAudit({
        action: 'admin.identityProviders.testTerminal',
        actorUserId: attempt.userId,
        error,
        reason: attempt.auditReason,
        targetId: attempt.id,
      });
      throw error;
    }
  };

  abandon = async (state: string, effectiveOrigin: string): Promise<void> => {
    const attempt = await this.attempts.reserve(state);
    try {
      assertIdentityProviderAttemptCallbackOrigin(attempt.redirectUri, effectiveOrigin);
    } catch (error) {
      await this.attempts.fail(attempt.id, 'OIDC_TEST_CALLBACK_ORIGIN_INVALID');
      await this.appendFailureAudit({
        action: 'admin.identityProviders.testTerminal',
        actorUserId: attempt.userId,
        error: new Error('OIDC_TEST_CALLBACK_ORIGIN_INVALID'),
        reason: attempt.auditReason,
        targetId: attempt.id,
      });
      throw error;
    }
    await this.attempts.fail(attempt.id, 'OIDC_TEST_AUTHORIZATION_FAILED');
    await this.appendAuditBestEffort({
      action: 'admin.identityProviders.testTerminal',
      actorUserId: attempt.userId,
      category: 'authorization_rejected',
      reason: attempt.auditReason,
      result: 'denied',
      targetId: attempt.id,
    });
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
      headers.Authorization = createClientSecretBasicAuthorization(
        input.clientId,
        input.clientSecret,
      );
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
}
