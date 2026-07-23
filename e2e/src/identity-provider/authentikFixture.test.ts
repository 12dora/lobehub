import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { importJWK, jwtVerify } from 'jose';
import { ProxyAgent, request } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTHENTIK_FIXTURE_CLIENT_ID,
  AUTHENTIK_FIXTURE_ISSUER,
  AUTHENTIK_FIXTURE_SUBJECT,
  type AuthentikFixture,
  startAuthentikFixture,
} from './authentikFixture';
import { type FixtureProxy, startFixtureProxy } from './fixtureProxy';

const CLIENT_SECRET = 'fixture-client-secret-value';
const REDIRECT_URI = 'http://localhost:3010/api/auth/oauth2/callback/work-account';
const EXPECTED_STATE = 'state-e2e';

let fixture: AuthentikFixture | undefined;
let proxy: FixtureProxy | undefined;
let dispatcher: ProxyAgent | undefined;

afterEach(async () => {
  await dispatcher?.close();
  await proxy?.close();
  await fixture?.close();
  dispatcher = undefined;
  proxy = undefined;
  fixture = undefined;
});

const setup = async (requireNonce = true) => {
  fixture = await startAuthentikFixture({
    clientSecret: CLIENT_SECRET,
    expectedRedirectUri: REDIRECT_URI,
    requireNonce,
  });
  proxy = await startFixtureProxy(fixture.port);
  const ca = await readFile(fixture.caCertificatePath, 'utf8');
  dispatcher = new ProxyAgent({ requestTls: { ca }, uri: proxy.url });
  return dispatcher;
};

const assertAuthorizationResponse = (callback: URL, expectedState: string) => {
  const code = callback.searchParams.get('code');
  const issuer = callback.searchParams.get('iss');
  const state = callback.searchParams.get('state');
  if (!code) throw new Error('authorization response code missing');
  if (issuer !== AUTHENTIK_FIXTURE_ISSUER) {
    throw new Error(`authorization response issuer mismatch: ${String(issuer)}`);
  }
  if (state !== expectedState) throw new Error('authorization response state mismatch');
  return { code, issuer, state };
};

const authorize = async (input: { nonce?: string; omitIss?: boolean; state?: string } = {}) => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL('authorize', AUTHENTIK_FIXTURE_ISSUER);
  url.searchParams.set('client_id', AUTHENTIK_FIXTURE_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email dingtalk');
  const expectedState = input.state ?? EXPECTED_STATE;
  url.searchParams.set('state', expectedState);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (input.nonce) url.searchParams.set('nonce', input.nonce);
  // Real Authentik omits RFC 9207 `iss`; fixture default still emits iss unless requested.
  if (input.omitIss) url.searchParams.set('fixture_omit_iss', '1');

  const consent = await request(url, { dispatcher });
  const html = await consent.body.text();
  const consentId = html.match(/name="consent_id" value="([^"]+)"/)?.[1];
  expect(consentId).toBeTruthy();
  const approval = await request(new URL('consent', AUTHENTIK_FIXTURE_ISSUER), {
    body: new URLSearchParams({ consent_id: consentId! }).toString(),
    dispatcher,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  const callback = new URL(String(approval.headers.location));
  if (input.omitIss) {
    const code = callback.searchParams.get('code');
    const state = callback.searchParams.get('state');
    if (!code) throw new Error('authorization response code missing');
    if (state !== expectedState) throw new Error('authorization response state mismatch');
    expect(callback.searchParams.get('iss')).toBeNull();
    return { callback, code, issuer: null, state, verifier };
  }
  return { ...assertAuthorizationResponse(callback, expectedState), callback, verifier };
};

type TokenAuthentication = 'basic' | 'mixed' | 'none' | 'post';

const exchange = async (
  code: string,
  verifier: string,
  authentication: TokenAuthentication = 'basic',
  clientSecret = CLIENT_SECRET,
) => {
  const body = new URLSearchParams({
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
  });
  if (authentication === 'post' || authentication === 'mixed') {
    body.set('client_id', AUTHENTIK_FIXTURE_CLIENT_ID);
    body.set('client_secret', clientSecret);
  }
  return request(new URL('token', AUTHENTIK_FIXTURE_ISSUER), {
    body: body.toString(),
    dispatcher,
    headers: {
      ...((authentication === 'basic' || authentication === 'mixed') && {
        authorization: `Basic ${Buffer.from(`${AUTHENTIK_FIXTURE_CLIENT_ID}:${clientSecret}`).toString('base64')}`,
      }),
      'content-type': 'application/x-www-form-urlencoded',
    },
    method: 'POST',
  });
};

describe('Authentik fixture', () => {
  it('serves a strict RS256 OIDC flow with issuer, nonce, JWKS and trusted claims', async () => {
    await setup();
    const discoveryResponse = await request(
      new URL('.well-known/openid-configuration', AUTHENTIK_FIXTURE_ISSUER),
      { dispatcher },
    );
    const discovery = (await discoveryResponse.body.json()) as Record<string, unknown>;
    expect(discovery).toMatchObject({
      authorization_response_iss_parameter_supported: true,
      id_token_signing_alg_values_supported: ['RS256'],
      issuer: AUTHENTIK_FIXTURE_ISSUER,
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    });

    const { callback, code, issuer, state, verifier } = await authorize({ nonce: 'nonce-e2e' });
    expect(callback.searchParams.get('code')).toBe(code);
    expect(callback.searchParams.get('iss')).toBe(AUTHENTIK_FIXTURE_ISSUER);
    expect(callback.searchParams.get('state')).toBe(EXPECTED_STATE);
    expect({ issuer, state }).toEqual({
      issuer: AUTHENTIK_FIXTURE_ISSUER,
      state: EXPECTED_STATE,
    });
    const tokenResponse = await exchange(code, verifier);
    expect(tokenResponse.statusCode).toBe(200);
    const tokens = (await tokenResponse.body.json()) as {
      access_token: string;
      id_token: string;
    };
    const jwksResponse = await request(new URL('jwks', AUTHENTIK_FIXTURE_ISSUER), {
      dispatcher,
    });
    const jwks = (await jwksResponse.body.json()) as {
      keys: Array<JsonWebKey & { alg: string; kid: string; use: string }>;
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ alg: 'RS256', use: 'sig' });
    const key = await importJWK(jwks.keys[0], 'RS256');
    const verified = await jwtVerify(tokens.id_token, key, {
      audience: AUTHENTIK_FIXTURE_CLIENT_ID,
      issuer: AUTHENTIK_FIXTURE_ISSUER,
    });
    expect(verified.payload).toMatchObject({
      nonce: 'nonce-e2e',
      sub: AUTHENTIK_FIXTURE_SUBJECT,
    });
    await expect(
      jwtVerify(tokens.id_token, key, {
        audience: AUTHENTIK_FIXTURE_CLIENT_ID,
        issuer: 'https://wrong-issuer.invalid/',
      }),
    ).rejects.toThrow();

    const userinfoResponse = await request(new URL('userinfo', AUTHENTIK_FIXTURE_ISSUER), {
      dispatcher,
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(await userinfoResponse.body.json()).toMatchObject({
      'dingtalk_title': 'Engineering Director',
      'dingtalk_user_id': 'dt-e2e-001',
      'https://fintlabs.cloud/claims/dingtalk_user_id': 'dt-e2e-001',
      'https://fintlabs.cloud/claims/title': 'Engineering Director',
      'sub': AUTHENTIK_FIXTURE_SUBJECT,
    });
    expect(fixture?.log).toMatchObject({
      clientSecretBasicExchanges: 1,
      clientSecretPostExchanges: 0,
    });
  });

  it('can emit an authorization response without RFC 9207 iss (Authentik parity)', async () => {
    await setup();
    const { callback, code, issuer, state } = await authorize({
      nonce: 'nonce-no-iss',
      omitIss: true,
    });
    expect(code).toBeTruthy();
    expect(issuer).toBeNull();
    expect(state).toBe(EXPECTED_STATE);
    expect(callback.searchParams.has('iss')).toBe(false);
  });

  it('rejects authorization responses with a missing or wrong RFC 9207 issuer', async () => {
    await setup();
    const { callback } = await authorize({ nonce: 'nonce-e2e' });

    const missingIssuer = new URL(callback);
    missingIssuer.searchParams.delete('iss');
    expect(() => assertAuthorizationResponse(missingIssuer, EXPECTED_STATE)).toThrow(
      'authorization response issuer mismatch',
    );

    const wrongIssuer = new URL(callback);
    wrongIssuer.searchParams.set('iss', 'https://wrong-issuer.invalid/');
    expect(() => assertAuthorizationResponse(wrongIssuer, EXPECTED_STATE)).toThrow(
      'authorization response issuer mismatch',
    );
  });

  it('rejects missing state or nonce, a wrong verifier, and authorization-code replay', async () => {
    await setup();
    const missingState = new URL('authorize', AUTHENTIK_FIXTURE_ISSUER);
    missingState.searchParams.set('client_id', AUTHENTIK_FIXTURE_CLIENT_ID);
    expect((await request(missingState, { dispatcher })).statusCode).toBe(400);

    const missingNonceVerifier = randomBytes(32).toString('base64url');
    const missingNonce = new URL('authorize', AUTHENTIK_FIXTURE_ISSUER);
    missingNonce.searchParams.set('client_id', AUTHENTIK_FIXTURE_CLIENT_ID);
    missingNonce.searchParams.set(
      'redirect_uri',
      'http://localhost:3010/api/auth/oauth2/callback/work-account',
    );
    missingNonce.searchParams.set('response_type', 'code');
    missingNonce.searchParams.set('state', 'state-e2e');
    missingNonce.searchParams.set(
      'code_challenge',
      createHash('sha256').update(missingNonceVerifier).digest('base64url'),
    );
    missingNonce.searchParams.set('code_challenge_method', 'S256');
    expect((await request(missingNonce, { dispatcher })).statusCode).toBe(400);

    for (const wrongRedirectUri of [
      'http://localhost:3010/api/auth/oauth2/callback/wrong-provider',
      'http://localhost:9999/api/auth/oauth2/callback/work-account',
    ]) {
      const wrongRedirect = new URL('authorize', AUTHENTIK_FIXTURE_ISSUER);
      wrongRedirect.searchParams.set('client_id', AUTHENTIK_FIXTURE_CLIENT_ID);
      wrongRedirect.searchParams.set('redirect_uri', wrongRedirectUri);
      wrongRedirect.searchParams.set('response_type', 'code');
      wrongRedirect.searchParams.set('state', 'state-e2e');
      wrongRedirect.searchParams.set('nonce', 'nonce-e2e');
      wrongRedirect.searchParams.set(
        'code_challenge',
        createHash('sha256').update(missingNonceVerifier).digest('base64url'),
      );
      wrongRedirect.searchParams.set('code_challenge_method', 'S256');
      expect((await request(wrongRedirect, { dispatcher })).statusCode).toBe(400);
    }

    const { code, verifier } = await authorize({ nonce: 'nonce-e2e' });
    expect((await exchange(code, verifier, 'none')).statusCode).toBe(400);
    expect((await exchange(code, verifier, 'post', `${CLIENT_SECRET}-wrong`)).statusCode).toBe(400);
    expect((await exchange(code, verifier, 'mixed')).statusCode).toBe(400);
    expect((await exchange(code, `${verifier}-wrong`, 'post')).statusCode).toBe(400);
    expect((await exchange(code, verifier, 'post')).statusCode).toBe(200);
    expect((await exchange(code, verifier, 'post')).statusCode).toBe(400);
    expect(fixture?.log).toMatchObject({
      clientSecretBasicExchanges: 0,
      clientSecretPostExchanges: 1,
    });
    expect(fixture?.log.failedRequests).toBeGreaterThanOrEqual(9);
  });
});
