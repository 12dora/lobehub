// @vitest-environment node
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import type { SafeOutboundHttpClient } from '@/server/enterprise/security/outboundHttp';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

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
  codeChallengeMethodsSupported: ['S256'],
  idTokenSigningAlgValuesSupported: ['RS256'],
  issuer,
  jwksUri: `${issuer}/jwks`,
  responseTypesSupported: ['code'],
  scopesSupported: ['openid'],
  subjectTypesSupported: ['public'],
  tokenEndpoint: `${issuer}/token`,
  tokenEndpointAuthMethodsSupported: ['client_secret_basic'],
  userinfoEndpoint: null,
};

const cleanup = async () => {
  await db.delete(platformIdentityProviderTestAttempts);
  await db.delete(platformIdentityProviderSecrets);
  await db.delete(platformIdentityProviders);
  await db.delete(platformAuditLogs);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('IdentityProviderTestFlowService audit and provider binding', () => {
  it('audits terminal success, claim rejection, and provider-revision failure without credentials', async () => {
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
        ...(includeName ? { name: 'Ada' } : {}),
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

    const successStart = await start('verify successful work login');
    const successState = await signForStart(successStart.authorizationUrl, true);
    await expect(
      flow.callback({
        code: 'success-code',
        effectiveOrigin: 'https://app.example.test',
        state: successState,
      }),
    ).resolves.toMatchObject({ valid: true });

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
});
