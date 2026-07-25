// @vitest-environment node
import { sql } from 'drizzle-orm';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { account, users } from '@/database/schemas';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { type AppendPlatformAuditLogParams, PlatformAuditService } from '../platformAudit';
import type { IdentityProviderDiscoveryValidator } from './discoveryValidator';
import { IdentityProviderSecretStore } from './secretStore';
import { IdentityProviderTestFlowService } from './testFlowService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(47), keyId: 'test-key' }),
  providerId: 'test',
};
const secretService = new PlatformSecretService({ keyProvider });
const issuer = 'https://login.example.test';
const metadata = {
  authorizationEndpoint: `${issuer}/authorize`,
  authorizationResponseIssParameterSupported: false,
  codeChallengeMethodsSupported: ['S256'],
  idTokenSigningAlgValuesSupported: ['RS256'],
  issuer,
  jwksUri: `${issuer}/jwks`,
  responseTypesSupported: ['code'],
  scopesSupported: ['openid'],
  subjectTypesSupported: ['public'],
  tokenEndpoint: `${issuer}/token`,
  tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
  // Production login requires userinfo; the connection test must match that contract.
  userinfoEndpoint: `${issuer}/userinfo`,
};

const cleanup = async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.delete(platformIdentityProviderTestAttempts);
    await tx.delete(platformIdentityProviderSecrets);
    await tx.delete(platformIdentityProviders);
    await tx.delete(platformAuditLogs);
  });
};

beforeEach(cleanup);
afterEach(cleanup);

type AuditAppender = (
  executor: LobeChatDatabase | Transaction,
  input: AppendPlatformAuditLogParams,
) => Promise<void>;

const createFlowFixture = async (auditAppender?: AuditAppender) => {
  const [created] = await db
    .insert(platformIdentityProviders)
    .values({ clientId: 'client-id', displayName: 'Work', issuer, providerKey: 'work' })
    .returning();
  await new IdentityProviderSecretStore(db, secretService).persistClientSecret({
    expectedRevision: created.revision,
    providerId: created.id,
    value: 'client-secret-must-never-be-audited',
  });
  const discover = vi.fn().mockResolvedValue(metadata);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
  let idToken = '';
  const outbound = {
    fetch: vi.fn(async (url: string | URL) => {
      const href = url.toString();
      let body: Record<string, unknown>;
      if (href.endsWith('/token')) {
        body = { access_token: 'access-token-for-test', id_token: idToken, token_type: 'Bearer' };
      } else if (href.endsWith('/userinfo')) {
        // Only prove subject continuity. Profile claims come from the ID token so
        // claim-rejection fixtures (missing name/email) still fail as before.
        body = { sub: 'subject-1' };
      } else {
        body = { keys: [jwk] };
      }
      return {
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => body,
        ok: true,
        truncated: false,
      };
    }),
  } as unknown as SafeOutboundHttpClient;
  const flow = auditAppender
    ? new IdentityProviderTestFlowService(
        db,
        secretService,
        { discover } as unknown as IdentityProviderDiscoveryValidator,
        outbound,
        auditAppender,
      )
    : new IdentityProviderTestFlowService(
        db,
        secretService,
        { discover } as unknown as IdentityProviderDiscoveryValidator,
        outbound,
      );
  const signForStart = async (authorizationUrl: string, includeName: boolean) => {
    const nonce = new URL(authorizationUrl).searchParams.get('nonce')!;
    const now = Math.floor(Date.now() / 1000);
    idToken = await new SignJWT({
      aud: 'client-id',
      exp: now + 300,
      iat: now,
      iss: issuer,
      ...(includeName ? { email: 'ada@example.test', name: 'Ada' } : {}),
      nonce,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);
    return new URL(authorizationUrl).searchParams.get('state')!;
  };
  const start = (reason: string) =>
    flow.start({
      expectedRevision: 1,
      id: created.id,
      reason,
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-a',
      userId: 'admin-a',
    });
  return { created, flow, signForStart, start };
};

describe('IdentityProviderTestFlowService audit and provider binding', () => {
  it('rejects ID-token-only token responses that production login cannot use', async () => {
    const [created] = await db
      .insert(platformIdentityProviders)
      .values({ clientId: 'client-id', displayName: 'Work', issuer, providerKey: 'work-id-only' })
      .returning();
    await new IdentityProviderSecretStore(db, secretService).persistClientSecret({
      expectedRevision: created.revision,
      providerId: created.id,
      value: 'client-secret',
    });
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
    let idToken = '';
    const outbound = {
      fetch: vi.fn(async (url: string | URL) => {
        // Intentionally omit access_token — production getUserInfo rejects this shape.
        const body = url.toString().endsWith('/token') ? { id_token: idToken } : { keys: [jwk] };
        return {
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => body,
          ok: true,
          truncated: false,
        };
      }),
    } as unknown as SafeOutboundHttpClient;
    const flow = new IdentityProviderTestFlowService(
      db,
      secretService,
      {
        discover: vi.fn().mockResolvedValue(metadata),
      } as unknown as IdentityProviderDiscoveryValidator,
      outbound,
    );
    const started = await flow.start({
      expectedRevision: 1,
      id: created.id,
      reason: 'verify production token shape',
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-id-only',
      userId: 'admin-id-only',
    });
    const nonce = new URL(started.authorizationUrl).searchParams.get('nonce')!;
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const now = Math.floor(Date.now() / 1000);
    idToken = await new SignJWT({
      aud: 'client-id',
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      nonce,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);
    await expect(
      flow.callback({
        code: 'code',
        effectiveOrigin: 'https://app.example.test',
        state,
      }),
    ).rejects.toThrow('OIDC_TEST_ACCESS_TOKEN_REQUIRED');
  });

  it('rejects discovery without userinfo_endpoint (production requires userinfo)', async () => {
    const noUserinfo = { ...metadata, userinfoEndpoint: null };
    const [created] = await db
      .insert(platformIdentityProviders)
      .values({ clientId: 'client-id', displayName: 'Work', issuer, providerKey: 'work-no-ui' })
      .returning();
    await new IdentityProviderSecretStore(db, secretService).persistClientSecret({
      expectedRevision: created.revision,
      providerId: created.id,
      value: 'client-secret',
    });
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
    let idToken = '';
    const outbound = {
      fetch: vi.fn(async (url: string | URL) => {
        const body = url.toString().endsWith('/token')
          ? { access_token: 'access', id_token: idToken, token_type: 'Bearer' }
          : { keys: [jwk] };
        return {
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => body,
          ok: true,
          truncated: false,
        };
      }),
    } as unknown as SafeOutboundHttpClient;
    const flow = new IdentityProviderTestFlowService(
      db,
      secretService,
      {
        discover: vi.fn().mockResolvedValue(noUserinfo),
      } as unknown as IdentityProviderDiscoveryValidator,
      outbound,
    );
    const started = await flow.start({
      expectedRevision: 1,
      id: created.id,
      reason: 'userinfo endpoint required',
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-no-ui',
      userId: 'admin-no-ui',
    });
    const nonce = new URL(started.authorizationUrl).searchParams.get('nonce')!;
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const now = Math.floor(Date.now() / 1000);
    idToken = await new SignJWT({
      aud: 'client-id',
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      nonce,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);
    await expect(
      flow.callback({
        code: 'code',
        effectiveOrigin: 'https://app.example.test',
        state,
      }),
    ).rejects.toThrow('OIDC_TEST_USERINFO_REQUIRED');
  });

  it('enforces RFC 9207 iss on test callback when discovery advertises support', async () => {
    const rfcMetadata = {
      ...metadata,
      authorizationResponseIssParameterSupported: true,
    };
    const [created] = await db
      .insert(platformIdentityProviders)
      .values({ clientId: 'client-id', displayName: 'Work', issuer, providerKey: 'work-rfc' })
      .returning();
    await new IdentityProviderSecretStore(db, secretService).persistClientSecret({
      expectedRevision: created.revision,
      providerId: created.id,
      value: 'client-secret',
    });
    const discover = vi.fn().mockResolvedValue(rfcMetadata);
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
    let idToken = '';
    const outbound = {
      fetch: vi.fn(async (url: string | URL) => {
        const href = url.toString();
        let body: Record<string, unknown>;
        if (href.endsWith('/token')) {
          body = {
            access_token: 'access-token-for-test',
            id_token: idToken,
            token_type: 'Bearer',
          };
        } else if (href.endsWith('/userinfo')) {
          body = { sub: 'subject-1' };
        } else {
          body = { keys: [jwk] };
        }
        return {
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => body,
          ok: true,
          truncated: false,
        };
      }),
    } as unknown as SafeOutboundHttpClient;
    const flow = new IdentityProviderTestFlowService(
      db,
      secretService,
      { discover } as unknown as IdentityProviderDiscoveryValidator,
      outbound,
    );
    const started = await flow.start({
      expectedRevision: 1,
      id: created.id,
      reason: 'rfc9207 callback wiring',
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-rfc',
      userId: 'admin-rfc',
    });
    const nonce = new URL(started.authorizationUrl).searchParams.get('nonce')!;
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    const now = Math.floor(Date.now() / 1000);
    idToken = await new SignJWT({
      aud: 'client-id',
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      nonce,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);

    await expect(
      flow.callback({
        code: 'code',
        effectiveOrigin: 'https://app.example.test',
        state,
      }),
    ).rejects.toThrow('OIDC_TEST_RESPONSE_ISSUER_INVALID');

    // Restart for mismatched iss (state already consumed).
    const started2 = await flow.start({
      expectedRevision: 1,
      id: created.id,
      reason: 'rfc9207 mismatched iss',
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-rfc-2',
      userId: 'admin-rfc',
    });
    const nonce2 = new URL(started2.authorizationUrl).searchParams.get('nonce')!;
    const state2 = new URL(started2.authorizationUrl).searchParams.get('state')!;
    idToken = await new SignJWT({
      aud: 'client-id',
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      nonce: nonce2,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);
    await expect(
      flow.callback({
        code: 'code',
        effectiveOrigin: 'https://app.example.test',
        iss: 'https://evil.example.test',
        state: state2,
      }),
    ).rejects.toThrow('OIDC_TEST_RESPONSE_ISSUER_INVALID');

    const started3 = await flow.start({
      expectedRevision: 1,
      id: created.id,
      reason: 'rfc9207 correct iss',
      redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
      sessionId: 'session-rfc-3',
      userId: 'admin-rfc',
    });
    const nonce3 = new URL(started3.authorizationUrl).searchParams.get('nonce')!;
    const state3 = new URL(started3.authorizationUrl).searchParams.get('state')!;
    idToken = await new SignJWT({
      aud: 'client-id',
      email: 'ada@example.test',
      exp: now + 300,
      iat: now,
      iss: issuer,
      name: 'Ada',
      nonce: nonce3,
      sub: 'subject-1',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .sign(privateKey);
    await expect(
      flow.callback({
        code: 'code',
        effectiveOrigin: 'https://app.example.test',
        iss: issuer,
        state: state3,
      }),
    ).resolves.toMatchObject({ valid: true });
  });

  it('audits terminal success, claim rejection, and provider-revision failure without credentials', async () => {
    const { flow, signForStart, start } = await createFlowFixture();
    const userCountBefore = (await db.select({ id: users.id }).from(users)).length;
    const accountCountBefore = (await db.select({ id: account.id }).from(account)).length;

    const successStart = await start('verify successful work login');
    const successState = await signForStart(successStart.authorizationUrl, true);
    await expect(
      flow.callback({
        code: 'success-code',
        effectiveOrigin: 'https://app.example.test',
        state: successState,
      }),
    ).resolves.toMatchObject({ valid: true });
    expect(await db.select({ id: users.id }).from(users)).toHaveLength(userCountBefore);
    expect(await db.select({ id: account.id }).from(account)).toHaveLength(accountCountBefore);

    const rejectedStart = await start('verify required claims');
    const rejectedState = await signForStart(rejectedStart.authorizationUrl, false);
    await expect(
      flow.callback({
        code: 'rejected-code',
        effectiveOrigin: 'https://app.example.test',
        state: rejectedState,
      }),
    ).resolves.toMatchObject({ valid: false });

    const failedStart = await start('verify provider revision binding');
    const failedState = new URL(failedStart.authorizationUrl).searchParams.get('state')!;
    await db.update(platformIdentityProviders).set({ revision: 2 });
    await expect(
      flow.callback({
        code: 'must-not-be-audited',
        effectiveOrigin: 'https://app.example.test',
        state: failedState,
      }),
    ).rejects.toThrow('OIDC_TEST_PROVIDER_CHANGED');

    await expect(
      flow.start({
        expectedRevision: 0,
        id: 'missing-provider',
        reason: 'verify missing provider rejection',
        redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
        sessionId: 'session-a',
        userId: 'admin-a',
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');

    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'admin.identityProviders.testStart',
          reason: 'verify successful work login',
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.identityProviders.testStart',
          afterDiff: { category: 'not_found' },
          reason: 'verify missing provider rejection',
          result: 'failure',
        }),
        expect.objectContaining({
          action: 'admin.identityProviders.testTerminal',
          reason: 'verify successful work login',
          result: 'success',
        }),
        expect.objectContaining({
          action: 'admin.identityProviders.testTerminal',
          reason: 'verify required claims',
          result: 'denied',
        }),
        expect.objectContaining({
          action: 'admin.identityProviders.testTerminal',
          afterDiff: { category: 'provider_changed' },
          reason: 'verify provider revision binding',
          result: 'failure',
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toMatch(
      /success-code|rejected-code|must-not-be-audited|client-secret-must-never-be-audited|id_token/,
    );
  });

  it('rolls back attempt creation when the start success audit insert fails', async () => {
    const auditError = new Error('AUDIT_INSERT_FAILED');
    const auditAppender: AuditAppender = async (executor, input) => {
      if (input.action === 'admin.identityProviders.testStart' && input.result === 'success') {
        throw auditError;
      }
      await new PlatformAuditService(executor).append(input);
    };
    const { start } = await createFlowFixture(auditAppender);

    await expect(start('verify atomic test start')).rejects.toBe(auditError);

    await expect(db.select().from(platformIdentityProviderTestAttempts)).resolves.toHaveLength(0);
    await expect(db.select().from(platformAuditLogs)).resolves.toEqual([
      expect.objectContaining({
        action: 'admin.identityProviders.testStart',
        afterDiff: { category: 'oidc_test_failed' },
        result: 'failure',
      }),
    ]);
  });

  it.each([
    { expectedResult: 'success', includeName: true, label: 'terminal success' },
    { expectedResult: 'denied', includeName: false, label: 'claim denied' },
  ])('rolls back $label when its audit insert fails', async ({ expectedResult, includeName }) => {
    const auditError = new Error('AUDIT_INSERT_FAILED');
    const auditAppender: AuditAppender = async (executor, input) => {
      if (
        input.action === 'admin.identityProviders.testTerminal' &&
        input.result === expectedResult
      ) {
        throw auditError;
      }
      await new PlatformAuditService(executor).append(input);
    };
    const { flow, signForStart, start } = await createFlowFixture(auditAppender);
    const started = await start(`verify atomic ${expectedResult}`);
    const state = await signForStart(started.authorizationUrl, includeName);

    await expect(
      flow.callback({
        code: `${expectedResult}-code-must-not-be-audited`,
        effectiveOrigin: 'https://app.example.test',
        state,
      }),
    ).rejects.toBe(auditError);

    const [attempt] = await db.select().from(platformIdentityProviderTestAttempts);
    expect(attempt).toMatchObject({
      errorCode: 'AUDIT_INSERT_FAILED',
      result: null,
      status: 'failed',
    });
    const terminalAudits = (await db.select().from(platformAuditLogs)).filter(
      ({ action }) => action === 'admin.identityProviders.testTerminal',
    );
    expect(terminalAudits).toEqual([
      expect.objectContaining({
        afterDiff: { category: 'oidc_test_failed' },
        result: 'failure',
      }),
    ]);
    expect(JSON.stringify(terminalAudits)).not.toMatch(/code-must-not-be-audited|id_token|pkce/);
  });

  it('does not let a best-effort failure audit obscure the original business error', async () => {
    const auditAppender: AuditAppender = async () => {
      throw new Error('AUDIT_BACKEND_UNAVAILABLE');
    };
    const { flow } = await createFlowFixture(auditAppender);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      flow.start({
        expectedRevision: 0,
        id: 'missing-provider',
        reason: 'verify original error is preserved',
        redirectUri: 'https://app.example.test/oauth/identity-provider/test/callback',
        sessionId: 'session-a',
        userId: 'admin-a',
      }),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_NOT_FOUND');
    expect(errorSpy).toHaveBeenCalledWith(
      '[identityProviderTest] failure audit unavailable',
      expect.objectContaining({ action: 'admin.identityProviders.testStart' }),
    );
  });
});
