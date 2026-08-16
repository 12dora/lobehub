// @vitest-environment node
/**
 * DingTalk login driven through the real Better Auth `genericOAuth` handler.
 *
 * Unlike the adapter unit test (which calls `getToken` / `getUserInfo` directly), this exercises
 * the framework path that actually runs in production: `/sign-in/oauth2` → authorization URL →
 * `/oauth2/callback/:providerId`, with the signed state cookie, the database state store and the
 * user/account writes. It is what proves the security-relevant claims:
 *
 * - state is required, tamper-evident and single-use even though `pkce: false`;
 * - a non-allowed organisation is rejected before any user or account row is written;
 * - a DingTalk identity never links onto a pre-existing local account with the same email.
 */
import { DINGTALK_IDENTITY_PROVIDER_ISSUER } from '@lobechat/types';
import { betterAuth } from 'better-auth';
import type { MemoryDB } from 'better-auth/adapters/memory';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { genericOAuth } from 'better-auth/plugins';
import { describe, expect, it, vi } from 'vitest';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '@/server/enterprise/security/outboundHttp';
import { buildDingTalkDiscoveryMetadata } from '@/server/enterprise/services/identityProvider/kinds';

import {
  buildPlatformIdentityProvider,
  type RuntimeIdentityProvider,
} from './platformIdentityProvider';
import { platformIdentityProviderState } from './platformIdentityProviderState';

const baseURL = 'https://app.example.test/api/auth';
const publicAddress = '93.184.216.34';
const allowlist = [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }];

const jsonResponse = (body: unknown): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json; charset=utf-8' },
  status: 200,
  statusText: 'OK',
});

const runtimeProvider = (
  dingtalkAllowedCorps: RuntimeIdentityProvider['dingtalkAllowedCorps'],
): RuntimeIdentityProvider => ({
  autoProvision: true,
  buttonLabel: '使用钉钉登录',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: ['unionId'],
    email: ['email'],
    name: ['nick'],
    picture: ['avatarUrl'],
    subject: ['unionId'],
  },
  clientId: 'app-key',
  clientSecret: 'app-secret',
  dingtalkAllowedCorps,
  displayName: 'DingTalk',
  domainAllowlist: [],
  enabled: true,
  groupRoleMapping: {},
  icon: 'dingtalk',
  issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
  oidcMetadata: buildDingTalkDiscoveryMetadata(DINGTALK_IDENTITY_PROVIDER_ISSUER),
  providerKey: 'dingtalk',
  revision: 1,
  scopes: ['openid', 'corpid'],
  secretFingerprint: 'a'.repeat(64),
  type: 'dingtalk',
  usePkce: true,
});

const createHarness = (options?: {
  allowlist?: RuntimeIdentityProvider['dingtalkAllowedCorps'];
  corpId?: string;
  email?: string;
}) => {
  const database: MemoryDB = { account: [], session: [], user: [], verification: [] };
  // Any escape to the real network is a test failure, not a silent live call.
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected native OAuth fetch'));
  const transport = vi.fn<PinnedTransport>(async (request) => {
    if (request.url.pathname.endsWith('/oauth2/userAccessToken')) {
      return jsonResponse({
        accessToken: 'access-token',
        corpId: options?.corpId ?? 'ding42',
        expireIn: 7200,
      });
    }
    if (request.url.pathname.endsWith('/contact/users/me')) {
      return jsonResponse({
        avatarUrl: 'https://cdn.example.test/ada.png',
        ...(options?.email ? { email: options.email } : {}),
        nick: 'Ada',
        unionId: 'union-1',
      });
    }
    throw new Error(`Unexpected DingTalk request: ${request.url.pathname}`);
  });
  const outbound = new SafeOutboundHttpClient({
    mode: 'public-only',
    resolve: async () => [{ address: publicAddress, family: 4 }],
    transport,
  });
  const config = buildPlatformIdentityProvider(
    runtimeProvider(options?.allowlist ?? allowlist),
    'https://app.example.test',
    outbound,
  );
  const auth = betterAuth({
    account: {
      accountLinking: {
        allowDifferentEmails: true,
        enabled: true,
        // Mirrors defineConfig: DingTalk is deliberately absent from trustedProviders because
        // it cannot assert a verified email.
        trustedProviders: [],
      },
      storeStateStrategy: 'database',
    },
    baseURL,
    database: memoryAdapter(database),
    emailAndPassword: { enabled: true },
    plugins: [platformIdentityProviderState(['dingtalk']), genericOAuth({ config: [config] })],
    secret: 'platform-dingtalk-route-regression-secret',
  });

  const cookiesOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';', 1)[0])
      .join('; ');

  const start = async () => {
    const response = await auth.handler(
      new Request(`${baseURL}/sign-in/oauth2`, {
        body: JSON.stringify({
          callbackURL: 'https://app.example.test/after-login',
          disableRedirect: true,
          providerId: 'dingtalk',
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    const body = (await response.json()) as { url: string };
    return { authorizationUrl: new URL(body.url), cookie: cookiesOf(response) };
  };

  const callback = (
    flow: { authorizationUrl: URL; cookie: string },
    overrides: { state?: string | null } = {},
  ) => {
    const url = new URL(`${baseURL}/oauth2/callback/dingtalk`);
    url.searchParams.set('code', 'authorization-code');
    const state =
      overrides.state === undefined
        ? flow.authorizationUrl.searchParams.get('state')
        : overrides.state;
    if (state !== null) url.searchParams.set('state', state);
    return auth.handler(new Request(url, { headers: { Cookie: flow.cookie } }));
  };

  const signUpLocal = async (email: string) => {
    const response = await auth.handler(
      new Request(`${baseURL}/sign-up/email`, {
        body: JSON.stringify({ email, name: 'Local Ada', password: 'correct-horse-battery' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }),
    );
    expect(response.status).toBe(200);
    return response;
  };

  return { auth, callback, database, signUpLocal, start, transport };
};

const isSuccessfulLogin = (response: Response) =>
  response.headers.getSetCookie().some((cookie) => cookie.includes('session_token='));

describe('DingTalk login through the Better Auth genericOAuth handler', () => {
  it('signs in and provisions its own account for an allowed organisation', async () => {
    const harness = createHarness();
    const flow = await harness.start();
    // pkce: false — no code challenge is sent, but state still is.
    expect(flow.authorizationUrl.searchParams.get('code_challenge')).toBeNull();
    expect(flow.authorizationUrl.searchParams.get('prompt')).toBe('consent');
    expect(flow.authorizationUrl.searchParams.get('state')).toBeTruthy();

    const response = await harness.callback(flow);
    expect(isSuccessfulLogin(response)).toBe(true);
    expect(harness.database.user).toHaveLength(1);
    expect(harness.database.user[0]!.email).toBe('union-1@dingtalk.dingtalk.sso');
    expect(harness.database.account).toHaveLength(1);
    expect(harness.database.account[0]!.accountId).toBe('union-1');
    expect(harness.database.account[0]!.providerId).toBe('dingtalk');
  });

  it('rejects a missing, tampered or replayed state even with PKCE disabled', async () => {
    const missing = createHarness();
    const missingFlow = await missing.start();
    expect(isSuccessfulLogin(await missing.callback(missingFlow, { state: null }))).toBe(false);
    expect(missing.database.user).toHaveLength(0);

    const tampered = createHarness();
    const tamperedFlow = await tampered.start();
    expect(
      isSuccessfulLogin(await tampered.callback(tamperedFlow, { state: 'forged-state-value' })),
    ).toBe(false);
    expect(tampered.database.user).toHaveLength(0);

    const replayed = createHarness();
    const replayedFlow = await replayed.start();
    expect(isSuccessfulLogin(await replayed.callback(replayedFlow))).toBe(true);
    // The state verification row is consumed by the first callback.
    expect(isSuccessfulLogin(await replayed.callback(replayedFlow))).toBe(false);
    expect(replayed.database.user).toHaveLength(1);
    expect(replayed.database.account).toHaveLength(1);
  });

  it('rejects a non-allowed organisation before any user or account row is written', async () => {
    const harness = createHarness({ corpId: 'ding99' });
    const flow = await harness.start();
    const response = await harness.callback(flow);

    expect(isSuccessfulLogin(response)).toBe(false);
    expect(harness.database.user).toHaveLength(0);
    expect(harness.database.account).toHaveLength(0);
    expect(harness.database.session).toHaveLength(0);
    // Only the token endpoint was reached — the profile read never happened.
    expect(harness.transport).toHaveBeenCalledTimes(1);
  });

  it('rejects every organisation when the allowlist is empty', async () => {
    const harness = createHarness({ allowlist: [] });
    const flow = await harness.start();
    expect(isSuccessfulLogin(await harness.callback(flow))).toBe(false);
    expect(harness.database.user).toHaveLength(0);
  });

  it('never links a DingTalk identity onto a pre-existing local account with the same email', async () => {
    const harness = createHarness({ email: 'ada@example.test' });
    await harness.signUpLocal('ada@example.test');
    expect(harness.database.user).toHaveLength(1);
    const localUserId = harness.database.user[0]!.id;
    // Simulate the strongest case: the local account is email-verified.
    harness.database.user[0]!.emailVerified = true;

    const flow = await harness.start();
    const response = await harness.callback(flow);

    // Better Auth answers "account not linked" — no DingTalk account is attached to the local user.
    expect(isSuccessfulLogin(response)).toBe(false);
    expect(
      harness.database.account.filter((account) => account.providerId === 'dingtalk'),
    ).toHaveLength(0);
    expect(
      harness.database.account.filter((account) => account.userId === localUserId),
    ).toHaveLength(1);
    expect(harness.database.user).toHaveLength(1);
  });
});
