import { createHash } from 'node:crypto';

import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { SafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  assertIdentityProviderAttemptCallbackOrigin,
  buildIdentityProviderClaimPreview,
  createClientSecretBasicAuthorization,
  summarizeIdentityProviderClaimPreview,
  verifyIdentityProviderIdToken,
} from './testFlowService';

/** Test-local SHA-256 helper matching production attempt-store digests. */
const hashIdentityProviderTestValue = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

describe('buildIdentityProviderClaimPreview', () => {
  it('returns only the fixed allowlist and structured required-claim issues', () => {
    const preview = buildIdentityProviderClaimPreview(
      {
        access_token: 'must-not-leak',
        custom: 'must-not-leak',
        email: 'admin@example.test',
        name: '',
        nested: { password: 'must-not-leak' },
        sub: 'subject-1',
      },
      GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
    );
    expect(preview).toEqual({
      claims: { email: 'admin@example.test', sub: 'subject-1' },
      issues: [{ code: 'required_claim_missing', field: 'name' }],
      valid: false,
    });
    expect(JSON.stringify(preview)).not.toMatch(/access_token|password|custom/);
  });

  it('uses mapped fallback claims for validation without expanding preview fields', () => {
    const preview = buildIdentityProviderClaimPreview(
      {
        employee_email: 'ada@example.test',
        employee_name: 'Ada',
        employee_subject: '42',
        private_claim: 'no',
      },
      {
        ...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
        email: ['employee_email'],
        name: ['employee_name'],
        subject: ['employee_subject'],
      },
    );
    expect(preview).toEqual({ claims: {}, issues: [], valid: true });
  });

  it('rejects missing, malformed, and domain-denied emails like production login', () => {
    const mapping = GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping;
    expect(
      buildIdentityProviderClaimPreview({ name: 'Ada', sub: 'subject-1' }, mapping),
    ).toMatchObject({
      issues: [{ code: 'required_claim_missing', field: 'email' }],
      valid: false,
    });
    expect(
      buildIdentityProviderClaimPreview(
        { email: 'not-an-email', name: 'Ada', sub: 'subject-1' },
        mapping,
      ),
    ).toMatchObject({
      issues: [{ code: 'email_invalid', field: 'email' }],
      valid: false,
    });
    expect(
      buildIdentityProviderClaimPreview(
        { email: 'ada@attacker.test', name: 'Ada', sub: 'subject-1' },
        mapping,
        ['example.test'],
      ),
    ).toMatchObject({
      issues: [{ code: 'email_domain_denied', field: 'email' }],
      valid: false,
    });
    expect(
      buildIdentityProviderClaimPreview(
        { email: 'ada@example.test', name: 'Ada', sub: 'subject-1' },
        mapping,
        ['example.test'],
      ),
    ).toMatchObject({ issues: [], valid: true });
  });

  it('redacts every PII value before the admin result leaves the service', () => {
    const summary = summarizeIdentityProviderClaimPreview({
      claims: {
        dingtalk_user_id: 'ding-user-42',
        email: 'admin@example.test',
        name: 'Ada Lovelace',
        picture: 'https://images.example.test/private/avatar.png',
        sub: 'subject-1',
      },
      issues: [],
      valid: true,
    });

    expect(summary).toEqual({
      claims: {
        dingtalk_user_id: { present: true, type: 'string' },
        email: { present: true, type: 'string' },
        name: { present: true, type: 'string' },
        picture: { present: true, type: 'string' },
        sub: { present: true, type: 'string' },
      },
      issues: [],
      valid: true,
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /ding-user-42|admin@example\.test|Ada Lovelace|private\/avatar|subject-1/,
    );
  });
});

describe('OIDC ID token verification', () => {
  const issuer = 'https://login.example.test';
  const clientId = 'client-id';
  const nonce = 'nonce-value';
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
    userinfoEndpoint: null,
  };

  const setup = async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), alg: 'RS256', kid: 'key-1', use: 'sig' };
    const now = Math.floor(Date.now() / 1000);
    const sign = (payload: Record<string, unknown> = {}, kid: string | null = 'key-1') => {
      const jwt = new SignJWT({
        aud: clientId,
        exp: now + 300,
        iat: now,
        iss: issuer,
        nonce,
        sub: 'subject-1',
        ...payload,
      });
      return jwt.setProtectedHeader({ alg: 'RS256', ...(kid ? { kid } : {}) }).sign(privateKey);
    };
    const outbound = {
      fetch: async () => ({
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ keys: [jwk] }),
        ok: true,
        truncated: false,
      }),
    } as unknown as SafeOutboundHttpClient;
    return { jwk, now, outbound, sign };
  };

  it('accepts a real signature with required temporal and audience claims', async () => {
    const { outbound, sign } = await setup();
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign(),
        metadata,
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound,
      }),
    ).resolves.toMatchObject({ sub: 'subject-1' });
  });

  it('accepts multiple audiences only with an exact authorized-party claim', async () => {
    const { outbound, sign } = await setup();
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign({ aud: [clientId, 'other'], azp: clientId }),
        metadata,
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound,
      }),
    ).resolves.toMatchObject({ azp: clientId });
  });

  it.each([
    ['missing exp', { exp: undefined }],
    ['missing iat', { iat: undefined }],
    ['stale iat', { iat: Math.floor(Date.now() / 1000) - 601 }],
    ['future iat', { iat: Math.floor(Date.now() / 1000) + 120 }],
    ['excessive lifetime', { exp: Math.floor(Date.now() / 1000) + 7200 }],
    ['multiple aud without azp', { aud: ['client-id', 'other'] }],
    ['wrong azp', { azp: 'other' }],
  ])('rejects %s', async (_label, payload) => {
    const { outbound, sign } = await setup();
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign(payload),
        metadata,
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound,
      }),
    ).rejects.toThrow('OIDC_TEST_ID_TOKEN_INVALID');
  });

  it('rejects missing/unknown/duplicate kid, unannounced alg, and wrong signatures', async () => {
    const { jwk, outbound, sign } = await setup();
    for (const token of [await sign({}, null), await sign({}, 'unknown')]) {
      await expect(
        verifyIdentityProviderIdToken({
          clientId,
          idToken: token,
          metadata,
          nonceHash: hashIdentityProviderTestValue(nonce),
          outbound,
        }),
      ).rejects.toThrow('OIDC_TEST_ID_TOKEN_INVALID');
    }
    const duplicateOutbound = {
      fetch: async () => ({
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ keys: [jwk, { ...jwk }] }),
        ok: true,
        truncated: false,
      }),
    } as unknown as SafeOutboundHttpClient;
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign(),
        metadata,
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound: duplicateOutbound,
      }),
    ).rejects.toThrow('OIDC_TEST_ID_TOKEN_INVALID');
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign(),
        metadata: { ...metadata, idTokenSigningAlgValuesSupported: ['PS256'] },
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound,
      }),
    ).rejects.toThrow('OIDC_TEST_ID_TOKEN_INVALID');

    const other = await setup();
    const wrongKeyOutbound = {
      fetch: async () => ({
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ keys: [other.jwk] }),
        ok: true,
        truncated: false,
      }),
    } as unknown as SafeOutboundHttpClient;
    await expect(
      verifyIdentityProviderIdToken({
        clientId,
        idToken: await sign(),
        metadata,
        nonceHash: hashIdentityProviderTestValue(nonce),
        outbound: wrongKeyOutbound,
      }),
    ).rejects.toThrow('OIDC_TEST_ID_TOKEN_INVALID');
  });
});

describe('client_secret_basic', () => {
  it('form-encodes each credential before joining and base64 encoding', () => {
    const header = createClientSecretBasicAuthorization('client:id +', 's&e:cret +');
    expect(Buffer.from(header.slice('Basic '.length), 'base64').toString()).toBe(
      'client%3Aid+%2B:s%26e%3Acret+%2B',
    );
  });

  it('requires the callback effective origin to exactly match the issued redirect', () => {
    expect(() =>
      assertIdentityProviderAttemptCallbackOrigin(
        'https://app.example.test/oauth/identity-provider/test/callback',
        'https://fallback.example.test',
      ),
    ).toThrow('OIDC_TEST_CALLBACK_ORIGIN_INVALID');
  });
});
