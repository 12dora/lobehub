import {
  isValidDingTalkCorpId,
  PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS,
  type PlatformIdentityProviderClaimPreview,
  type PlatformIdentityProviderDingTalkCapture,
  type PlatformIdentityProviderType,
  type PlatformOidcDiscoveryMetadata,
} from '@lobechat/types';
import { and, eq } from 'drizzle-orm';
import type { JWTPayload } from 'jose';
import { z } from 'zod';

import { PlatformIdentityProviderModel } from '@/database/models/platform';
import { platformIdentityProviders } from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import type { PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../audit/auditActionCatalog';
import { type AppendPlatformAuditLogParams, PlatformAuditService } from '../platformAudit';
import { buildIdentityProviderClaimPreview } from './claimValidation';
import {
  assertAuthorizationResponseIssuer,
  type IdentityProviderDiscoveryValidator,
} from './discoveryValidator';
import { verifyPlatformOidcIdToken } from './idTokenVerifier';
import {
  assertDingTalkIssuer,
  DingTalkApiError,
  exchangeDingTalkAuthorizationCode,
  fetchDingTalkUserProfile,
  resolveStaticIdentityProviderMetadata,
  toDingTalkClaims,
} from './kinds';
import { IdentityProviderSecretStore } from './secretStore';
import { IdentityProviderTestAttemptStore } from './testAttemptStore';
import { exchangePlatformOidcAuthorizationCode } from './tokenExchange';

const TOKEN_TIMEOUT_MS = 5000;
const TOKEN_MAX_BYTES = 64 * 1024;

export { buildIdentityProviderClaimPreview } from './claimValidation';
export { createClientSecretBasicAuthorization } from './tokenExchange';

type AuditAppender = (
  db: LobeChatDatabase | Transaction,
  input: AppendPlatformAuditLogParams,
) => Promise<void>;

const appendPlatformAudit: AuditAppender = async (db, input) => {
  await new PlatformAuditService(db).append(input);
};

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

export const summarizeIdentityProviderClaimPreview = (
  preview: PlatformIdentityProviderClaimPreview | null,
) => {
  if (!preview) return null;
  const claims: Partial<
    Record<
      (typeof PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS)[number],
      { present: true; type: 'string' }
    >
  > = {};
  for (const claim of PLATFORM_IDENTITY_PROVIDER_PREVIEW_CLAIMS) {
    if (preview.claims[claim] !== undefined) claims[claim] = { present: true, type: 'string' };
  }
  return {
    claims,
    // Claim VALUES never leave the server — except the DingTalk capture, which is the entire
    // point of running the test for that kind (the admin cannot type a corpId by hand) and
    // carries no credential material.
    ...(preview.dingtalk ? { dingtalk: preview.dingtalk } : {}),
    issues: preview.issues,
    valid: preview.valid,
  };
};

const failureCategory = (error: unknown): string => {
  if (!(error instanceof Error)) return 'oidc_test_failed';
  if (error.message.includes('NOT_FOUND')) return 'not_found';
  if (error.message.includes('CALLBACK_ORIGIN')) return 'callback_origin_invalid';
  if (error.message.includes('PROVIDER_CHANGED')) return 'provider_changed';
  if (error.message.includes('CLAIM')) return 'claim_validation_failed';
  if (error instanceof DingTalkApiError) {
    return error.detail.stage === 'profile'
      ? 'dingtalk_profile_rejected'
      : 'dingtalk_token_rejected';
  }
  if (error.message.includes('CORP')) return 'corp_mismatch';
  // Order matters: OIDC_TEST_RESPONSE_ISSUER_INVALID also contains "ISSUER_INVALID".
  if (error.message.includes('RESPONSE_ISSUER')) return 'response_issuer_invalid';
  if (error.message.includes('ISSUER_INVALID')) return 'issuer_invalid';
  if (error.message.includes('NONCE') || error.message.includes('ID_TOKEN')) {
    return 'id_token_validation_failed';
  }
  if (error.message.includes('SECRET')) return 'secret_unavailable';
  if (error.message.includes('REMOTE') || error.message.includes('DISCOVERY')) {
    return 'remote_validation_failed';
  }
  return 'oidc_test_failed';
};

/**
 * Terminal error code persisted on a failed attempt, and shown to the administrator.
 *
 * DingTalk rejections additionally carry the provider's own error code as a `:suffix`
 * (`OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound`). That code is a
 * stable machine token — never the client secret, the authorization code or a token — and it is
 * the single most useful thing an administrator can see when a first real login fails.
 */
export const terminalAttemptErrorCode = (error: unknown): string => {
  if (error instanceof DingTalkApiError) {
    const base =
      error.detail.stage === 'profile'
        ? error.detail.status === 403
          ? 'OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN'
          : 'OIDC_TEST_DINGTALK_PROFILE_REJECTED'
        : 'OIDC_TEST_DINGTALK_TOKEN_REJECTED';
    // Sanitized one-liner so a live smoke failure is not invisible in server logs either.
    console.error('[identityProviderTest] DingTalk rejected the request', {
      dingtalkCode: error.detail.dingtalkCode ?? 'unknown',
      stage: error.detail.stage,
      status: error.detail.status ?? 0,
    });
    return error.detail.dingtalkCode ? `${base}:${error.detail.dingtalkCode}` : base;
  }
  return error instanceof Error && /^[A-Z0-9_]{1,128}$/.test(error.message)
    ? error.message
    : 'OIDC_TEST_FAILED';
};

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
    return await verifyPlatformOidcIdToken({
      clientId: input.clientId,
      idToken: input.idToken,
      metadata: input.metadata,
      nonce: { expectedHash: input.nonceHash, mode: 'required' },
      outbound: input.outbound,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'PLATFORM_OIDC_NONCE_INVALID') {
      throw new Error('OIDC_TEST_NONCE_INVALID', { cause: error });
    }
    throw new Error('OIDC_TEST_ID_TOKEN_INVALID', { cause: error });
  }
};

/** Independent OIDC draft test flow. It never calls Better Auth or writes user/link records. */
export class IdentityProviderTestFlowService {
  private readonly attempts: IdentityProviderTestAttemptStore;

  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secretService: PlatformSecretService,
    private readonly discovery: IdentityProviderDiscoveryValidator,
    private readonly outbound: SafeOutboundHttpClient,
    private readonly auditAppender: AuditAppender = appendPlatformAudit,
  ) {
    this.attempts = new IdentityProviderTestAttemptStore(db, this.secretService);
    this.secretStore = new IdentityProviderSecretStore(db, this.secretService);
  }

  private readonly secretStore: IdentityProviderSecretStore;

  private appendAudit = async (
    db: LobeChatDatabase | Transaction,
    input: {
      action: AuditAction;
      actorUserId: string;
      category?: string;
      reason: string;
      result: 'denied' | 'failure' | 'success';
      targetId: string;
    },
  ): Promise<void> => {
    await this.auditAppender(db, {
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
    action: AuditAction;
    actorUserId: string;
    error: unknown;
    reason: string;
    targetId: string;
  }): Promise<void> => {
    try {
      await this.db.transaction((tx) =>
        this.appendAudit(tx, {
          action: input.action,
          actorUserId: input.actorUserId,
          category: failureCategory(input.error),
          reason: input.reason,
          result: 'failure',
          targetId: input.targetId,
        }),
      );
    } catch (auditError) {
      console.error('[identityProviderTest] failure audit unavailable', {
        action: input.action,
        errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
      });
    }
  };

  private reapExpiredBestEffort = async (): Promise<void> => {
    try {
      await this.attempts.cleanupExpired();
    } catch (error) {
      console.error('[identityProviderTest] attempt cleanup unavailable', {
        errorClass: error instanceof Error ? error.name : 'UnknownError',
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
    await this.reapExpiredBestEffort();
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
      const metadata = await this.resolveMetadata({ issuer: provider.issuer, type: provider.type });
      const authorizationUrl = new URL(metadata.authorizationEndpoint);
      const reserved = [
        'client_id',
        'code_challenge',
        'code_challenge_method',
        'max_age',
        'nonce',
        'prompt',
        'redirect_uri',
        'response_type',
        'scope',
        'state',
      ];
      if (reserved.some((key) => authorizationUrl.searchParams.has(key))) {
        throw new Error('OIDC_TEST_DISCOVERY_INVALID');
      }
      const attempt = await this.db.transaction(async (tx) => {
        const currentProvider = await new PlatformIdentityProviderModel(tx).get(provider.id);
        if (
          !currentProvider ||
          currentProvider.status !== 'draft' ||
          currentProvider.migrationRequired ||
          currentProvider.revision !== provider.revision ||
          !currentProvider.issuer ||
          !currentProvider.clientId ||
          !currentProvider.secret.configured
        ) {
          throw new Error('OIDC_TEST_PROVIDER_CHANGED');
        }
        const [binding] = await tx
          .select({
            fingerprint: platformIdentityProviders.secretFingerprint,
            ref: platformIdentityProviders.secretRef,
          })
          .from(platformIdentityProviders)
          .where(
            and(
              eq(platformIdentityProviders.id, currentProvider.id),
              eq(platformIdentityProviders.revision, currentProvider.revision),
              eq(platformIdentityProviders.status, 'draft'),
              eq(platformIdentityProviders.migrationRequired, false),
            ),
          )
          .limit(1);
        if (!binding?.ref || !binding.fingerprint) {
          throw new Error('OIDC_TEST_PROVIDER_CHANGED');
        }
        const issued = await new IdentityProviderTestAttemptStore(tx, this.secretService).issue({
          auditReason: input.reason,
          providerId: currentProvider.id,
          providerRevision: currentProvider.revision,
          providerSecretFingerprint: binding.fingerprint,
          providerSecretRef: binding.ref,
          redirectUri: input.redirectUri,
          sessionId: input.sessionId,
          userId: input.userId,
        });
        await this.appendAudit(tx, {
          action: 'admin.identityProviders.testStart',
          actorUserId: input.userId,
          reason: input.reason,
          result: 'success',
          targetId: issued.attemptId,
        });
        return issued;
      });
      authorizationUrl.searchParams.set('client_id', provider.clientId);
      authorizationUrl.searchParams.set('redirect_uri', input.redirectUri);
      authorizationUrl.searchParams.set('response_type', 'code');
      authorizationUrl.searchParams.set('scope', provider.scopes.join(' '));
      authorizationUrl.searchParams.set('state', attempt.state);
      if (provider.type === 'dingtalk') {
        // DingTalk implements neither PKCE, nonce, nor max_age. `prompt=consent` is its only
        // way to force the interactive authorization screen for the safe-login test.
        authorizationUrl.searchParams.set('prompt', 'consent');
      } else {
        authorizationUrl.searchParams.set('code_challenge', attempt.codeChallenge);
        authorizationUrl.searchParams.set('code_challenge_method', 'S256');
        authorizationUrl.searchParams.set('nonce', attempt.nonce);
        // Force a fresh interactive authentication for the safe-login test so it never silently
        // rides — or is confused with — the admin's ambient IdP session. The test validates
        // whoever authenticates here; it must be a deliberate login, not the current operator's.
        authorizationUrl.searchParams.set('prompt', 'login');
        authorizationUrl.searchParams.set('max_age', '0');
      }
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
    /** RFC 9207 authorization-response issuer (optional when OP does not advertise support). */
    iss?: string | null;
    state: string;
  }): Promise<{ attemptId: string; valid: boolean }> => {
    await this.reapExpiredBestEffort();
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
      const metadata = await this.resolveMetadata({ issuer: provider.issuer, type: provider.type });
      assertAuthorizationResponseIssuer({ iss: input.iss, metadata });
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
      const resolved =
        provider.type === 'dingtalk'
          ? await this.resolveDingTalkClaims({
              clientId: provider.clientId,
              clientSecret: secret,
              code: input.code,
              issuer: provider.issuer,
              providerKey: provider.providerKey,
            })
          : {
              claims: await this.resolveOidcClaims({
                attempt,
                clientId: provider.clientId,
                clientSecret: secret,
                code: input.code,
                metadata,
              }),
            };
      const preview = {
        ...buildIdentityProviderClaimPreview(
          resolved.claims,
          provider.claimMapping,
          provider.domainAllowlist,
        ),
        // Capture outcome: the admin runs this flow precisely to learn the organisation id.
        ...(resolved.dingtalk ? { dingtalk: resolved.dingtalk } : {}),
      };
      await this.db.transaction(async (tx) => {
        const store = new IdentityProviderTestAttemptStore(tx, this.secretService);
        if (preview.valid) {
          await store.succeed(attempt, preview);
        } else {
          const changed = await store.fail(attempt.id, 'OIDC_TEST_CLAIM_VALIDATION_FAILED');
          if (!changed) throw new Error('OIDC_TEST_PROVIDER_CHANGED');
        }
        await this.appendAudit(tx, {
          action: 'admin.identityProviders.testTerminal',
          actorUserId: attempt.userId,
          category: preview.valid ? undefined : 'claim_validation_rejected',
          reason: attempt.auditReason,
          result: preview.valid ? 'success' : 'denied',
          targetId: attempt.id,
        });
      });
      return { attemptId: attempt.id, valid: preview.valid };
    } catch (error) {
      const code = terminalAttemptErrorCode(error);
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
    await this.reapExpiredBestEffort();
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
    try {
      await this.db.transaction(async (tx) => {
        const changed = await new IdentityProviderTestAttemptStore(tx, this.secretService).fail(
          attempt.id,
          'OIDC_TEST_AUTHORIZATION_FAILED',
        );
        if (!changed) throw new Error('OIDC_TEST_REPLAYED');
        await this.appendAudit(tx, {
          action: 'admin.identityProviders.testTerminal',
          actorUserId: attempt.userId,
          category: 'authorization_rejected',
          reason: attempt.auditReason,
          result: 'denied',
          targetId: attempt.id,
        });
      });
    } catch (error) {
      await this.attempts.fail(attempt.id, 'OIDC_TEST_FAILED');
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

  result = async (input: { attemptId: string; sessionId: string; userId: string }) => {
    await this.reapExpiredBestEffort();
    const result = await this.attempts.getResult(input);
    if (!result) throw new Error('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    return { ...result, result: summarizeIdentityProviderClaimPreview(result.result) };
  };

  /**
   * Endpoints for the tested draft. Kinds that publish no discovery document (DingTalk)
   * resolve statically; strict-OIDC kinds still discover over the network exactly as before.
   */
  private resolveMetadata = async (provider: {
    issuer: string;
    type: PlatformIdentityProviderType;
  }): Promise<PlatformOidcDiscoveryMetadata> =>
    resolveStaticIdentityProviderMetadata(provider.type, provider.issuer) ??
    this.discovery.discover(provider.issuer);

  /**
   * Strict-OIDC safe-login claims. Matches the production login contract
   * (platformIdentityProvider.getUserInfo): both a non-empty access token and a userinfo
   * endpoint are mandatory, and an ID-token-only response must not mark the attempt
   * successful — publication trusts this gate.
   */
  private resolveOidcClaims = async (input: {
    attempt: { nonceHash: string; pkceVerifier: string; redirectUri: string };
    clientId: string;
    clientSecret: string;
    code: string;
    metadata: PlatformOidcDiscoveryMetadata;
  }): Promise<Record<string, unknown>> => {
    const token = await this.exchangeCode({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      code: input.code,
      metadata: input.metadata,
      pkceVerifier: input.attempt.pkceVerifier,
      redirectUri: input.attempt.redirectUri,
    });
    if (!token.access_token) throw new Error('OIDC_TEST_ACCESS_TOKEN_REQUIRED');
    if (!input.metadata.userinfoEndpoint) throw new Error('OIDC_TEST_USERINFO_REQUIRED');
    const idClaims = await verifyIdentityProviderIdToken({
      clientId: input.clientId,
      idToken: token.id_token,
      metadata: input.metadata,
      nonceHash: input.attempt.nonceHash,
      outbound: this.outbound,
    });
    const userinfo = z.record(z.string(), z.unknown()).parse(
      await safeJson(
        await this.outbound.fetch(input.metadata.userinfoEndpoint, {
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
    return { ...idClaims, ...userinfo };
  };

  /**
   * DingTalk safe-login claims AND organisation capture: JSON token exchange (no id_token, no
   * PKCE) then the header-authenticated profile read — exactly the sequence the production
   * adapter runs, so a green test really does gate publication.
   *
   * The organisation allowlist is deliberately NOT enforced here: this flow is how an
   * administrator discovers a corpId in the first place. Nothing about it touches user or
   * account state, and its result is a claim *preview* only.
   */
  private resolveDingTalkClaims = async (input: {
    clientId: string;
    clientSecret: string;
    code: string;
    issuer: string;
    providerKey: string;
  }): Promise<{
    claims: Record<string, unknown>;
    dingtalk?: PlatformIdentityProviderDingTalkCapture;
  }> => {
    assertDingTalkIssuer(input.issuer, 'OIDC_TEST_ISSUER_INVALID');
    const token = await exchangeDingTalkAuthorizationCode({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      code: input.code,
      errorCode: 'OIDC_TEST_DINGTALK_TOKEN_REJECTED',
      outbound: this.outbound,
    });
    // Without the `corpid` scope there is nothing to capture and nothing the runtime could
    // ever match, so the test fails rather than reporting a green result the admin cannot use.
    if (!isValidDingTalkCorpId(token.corpId)) throw new Error('OIDC_TEST_CORP_ID_MISSING');
    const profile = await fetchDingTalkUserProfile({
      accessToken: token.accessToken,
      errorCode: 'OIDC_TEST_DINGTALK_PROFILE_REJECTED',
      outbound: this.outbound,
    });
    const claims = toDingTalkClaims(profile, {
      errorCode: 'OIDC_TEST_CLAIM_VALIDATION_FAILED',
      providerKey: input.providerKey,
    });
    return {
      claims,
      dingtalk: {
        corpId: token.corpId,
        ...(profile.nick?.trim() ? { nick: profile.nick.trim().slice(0, 256) } : {}),
      },
    };
  };

  private exchangeCode = async (input: {
    clientId: string;
    clientSecret: string;
    code: string;
    metadata: PlatformOidcDiscoveryMetadata;
    pkceVerifier: string;
    redirectUri: string;
  }) => {
    return exchangePlatformOidcAuthorizationCode({
      ...input,
      errorCode: 'OIDC_TEST_REMOTE_INVALID',
      expectedRedirectUri: input.redirectUri,
      outbound: this.outbound,
      redirectUri: input.redirectUri,
    });
  };
}
