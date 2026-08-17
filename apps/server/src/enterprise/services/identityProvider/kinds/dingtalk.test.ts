// @vitest-environment node
import {
  buildDingTalkSyntheticEmail,
  DINGTALK_IDENTITY_PROVIDER_ISSUER,
  isDingTalkCorpAllowed,
  isDingTalkIdentityProviderIssuer,
  isReservedSyntheticIdentityEmail,
  isValidDingTalkProviderKey,
  parseDingTalkAllowedCorps,
} from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '../../../security/outboundHttp';
import {
  assertDingTalkCorpAllowed,
  assertDingTalkIssuer,
  buildDingTalkDiscoveryMetadata,
  DINGTALK_APP_TOKEN_ENDPOINT,
  DINGTALK_ORG_AUTH_INFO_ENDPOINT,
  DINGTALK_ORG_READ_SCOPE,
  DINGTALK_TOKEN_ENDPOINT,
  DINGTALK_USERINFO_ENDPOINT,
  DingTalkApiError,
  exchangeDingTalkAuthorizationCode,
  fetchDingTalkCorpName,
  fetchDingTalkUserProfile,
  toDingTalkClaims,
} from './dingtalk';
import { isStrictOidcIdentityProviderType, resolveStaticIdentityProviderMetadata } from './index';

const publicAddress = '93.184.216.34';
const allowlist = [{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' }];

const response = (
  body: unknown,
  overrides: Partial<PinnedTransportResponse> = {},
): PinnedTransportResponse => ({
  body: Buffer.from(JSON.stringify(body)),
  headers: { 'content-type': 'application/json' },
  status: 200,
  statusText: 'OK',
  ...overrides,
});

const setup = (transport: PinnedTransport) =>
  new SafeOutboundHttpClient({
    mode: 'public-only',
    resolve: async () => [{ address: publicAddress, family: 4 }],
    transport,
  });

describe('DingTalk issuer', () => {
  it('is a fixed constant — anything else fails closed', () => {
    expect(isDingTalkIdentityProviderIssuer(DINGTALK_IDENTITY_PROVIDER_ISSUER)).toBe(true);
    expect(isDingTalkIdentityProviderIssuer(`${DINGTALK_IDENTITY_PROVIDER_ISSUER}/ding42`)).toBe(
      false,
    );
    expect(isDingTalkIdentityProviderIssuer('https://evil.example')).toBe(false);
    expect(isDingTalkIdentityProviderIssuer(null)).toBe(false);

    expect(assertDingTalkIssuer(DINGTALK_IDENTITY_PROVIDER_ISSUER)).toBe(
      DINGTALK_IDENTITY_PROVIDER_ISSUER,
    );
    expect(() => assertDingTalkIssuer('https://evil.example')).toThrow(
      'PLATFORM_DINGTALK_ISSUER_INVALID',
    );
    expect(() => assertDingTalkIssuer(undefined)).toThrow('PLATFORM_DINGTALK_ISSUER_INVALID');
    expect(() => assertDingTalkIssuer('https://evil.example', 'OIDC_TEST_ISSUER_INVALID')).toThrow(
      'OIDC_TEST_ISSUER_INVALID',
    );
  });
});

describe('DingTalk organisation allowlist', () => {
  it('allows only captured organisations and fails closed on an empty list', () => {
    expect(isDingTalkCorpAllowed('ding42', allowlist)).toBe(true);
    expect(isDingTalkCorpAllowed('ding99', allowlist)).toBe(false);
    expect(isDingTalkCorpAllowed('ding42', [])).toBe(false);
    expect(isDingTalkCorpAllowed(undefined, allowlist)).toBe(false);
    expect(isDingTalkCorpAllowed('', allowlist)).toBe(false);
  });

  it('rejects a login from an organisation that is not allowed', () => {
    expect(() => assertDingTalkCorpAllowed({ actual: 'ding42', allowlist })).not.toThrow();
    expect(() => assertDingTalkCorpAllowed({ actual: 'ding99', allowlist })).toThrow(
      'PLATFORM_DINGTALK_CORP_NOT_ALLOWED',
    );
    // Missing corpId (the `corpid` scope was not granted) is a rejection, never a pass.
    expect(() => assertDingTalkCorpAllowed({ actual: undefined, allowlist })).toThrow(
      'PLATFORM_DINGTALK_CORP_NOT_ALLOWED',
    );
    // Empty allowlist allows nobody.
    expect(() => assertDingTalkCorpAllowed({ actual: 'ding42', allowlist: [] })).toThrow(
      'PLATFORM_DINGTALK_CORP_NOT_ALLOWED',
    );
  });

  it('parses persisted allowlists and rejects malformed entries', () => {
    expect(parseDingTalkAllowedCorps([])).toEqual([]);
    expect(
      parseDingTalkAllowedCorps([
        { addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'user_1', corpId: 'ding42', label: 'HQ' },
      ]),
    ).toEqual([
      { addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'user_1', corpId: 'ding42', label: 'HQ' },
    ]);
    expect(parseDingTalkAllowedCorps('nope')).toBeNull();
    expect(parseDingTalkAllowedCorps([{ addedAt: '2026-01-01T00:00:00.000Z' }])).toBeNull();
    expect(parseDingTalkAllowedCorps([{ addedAt: 'not-a-date', corpId: 'ding42' }])).toBeNull();
    expect(
      parseDingTalkAllowedCorps([{ addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding/../evil' }]),
    ).toBeNull();
    expect(
      parseDingTalkAllowedCorps([
        { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42' },
        { addedAt: '2026-01-02T00:00:00.000Z', corpId: 'ding42' },
      ]),
    ).toBeNull();
    expect(
      parseDingTalkAllowedCorps([
        { addedAt: '2026-01-01T00:00:00.000Z', corpId: 'ding42', label: 'x'.repeat(65) },
      ]),
    ).toBeNull();
  });
});

describe('DingTalk static metadata', () => {
  it('is used instead of network discovery, and only for the dingtalk kind', () => {
    expect(
      resolveStaticIdentityProviderMetadata('generic_oidc', 'https://id.example.com'),
    ).toBeNull();
    expect(resolveStaticIdentityProviderMetadata('authentik', 'https://id.example.com')).toBeNull();
    expect(isStrictOidcIdentityProviderType('generic_oidc')).toBe(true);
    expect(isStrictOidcIdentityProviderType('dingtalk')).toBe(false);

    const metadata = resolveStaticIdentityProviderMetadata(
      'dingtalk',
      DINGTALK_IDENTITY_PROVIDER_ISSUER,
    );
    // The runtime snapshot invariant requires metadata.issuer === provider.issuer.
    expect(metadata).toEqual(buildDingTalkDiscoveryMetadata(DINGTALK_IDENTITY_PROVIDER_ISSUER));
    expect(metadata?.issuer).toBe(DINGTALK_IDENTITY_PROVIDER_ISSUER);
    expect(metadata?.tokenEndpoint).toBe(DINGTALK_TOKEN_ENDPOINT);
    expect(metadata?.userinfoEndpoint).toBe(DINGTALK_USERINFO_ENDPOINT);
    // DingTalk signs nothing: the JWKS URI is an unresolvable sentinel, and PKCE is unsupported.
    expect(metadata?.jwksUri).toMatch(/\.invalid\/$/);
    expect(metadata?.codeChallengeMethodsSupported).toEqual([]);
  });

  it('refuses to synthesize metadata for a foreign issuer', () => {
    expect(() => resolveStaticIdentityProviderMetadata('dingtalk', 'https://evil.example')).toThrow(
      'PLATFORM_DINGTALK_ISSUER_INVALID',
    );
  });
});

describe('DingTalk token exchange', () => {
  it('posts a JSON body and returns the camelCase token without requiring an id_token', async () => {
    const transport = vi.fn<PinnedTransport>(async (request) => {
      expect(request.url.toString()).toBe(DINGTALK_TOKEN_ENDPOINT);
      expect(request.method).toBe('POST');
      expect(JSON.parse(request.body!.toString())).toEqual({
        clientId: 'app-key',
        clientSecret: 'app-secret',
        code: 'authorization-code',
        grantType: 'authorization_code',
      });
      expect(request.headers).toEqual({
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      });
      return response({
        accessToken: 'access-token',
        corpId: 'ding42',
        expireIn: 7200,
        refreshToken: 'refresh-token',
      });
    });
    const outbound = setup(transport);
    const fetchSpy = vi.spyOn(outbound, 'fetch');

    await expect(
      exchangeDingTalkAuthorizationCode({
        clientId: 'app-key',
        clientSecret: 'app-secret',
        code: 'authorization-code',
        outbound,
      }),
    ).resolves.toEqual({
      accessToken: 'access-token',
      corpId: 'ding42',
      expiresIn: 7200,
      refreshToken: 'refresh-token',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      DINGTALK_TOKEN_ENDPOINT,
      expect.objectContaining({ maxRedirects: 0, secretBearing: true, timeoutMs: 5000 }),
    );
  });

  it("carries DingTalk's own error code out of a rejected exchange", async () => {
    // The real 400 body an operator sees when the AppSecret is wrong.
    const failing = setup(async () =>
      response(
        { code: 'invalidParameter.idOrSecret.notFound', message: 'invalid', requestid: 'r-1' },
        { status: 400 },
      ),
    );
    const error = await exchangeDingTalkAuthorizationCode({
      clientId: 'app-key',
      clientSecret: 'wrong',
      code: 'bad',
      errorCode: 'OIDC_TEST_DINGTALK_TOKEN_REJECTED',
      outbound: failing,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(DingTalkApiError);
    expect((error as DingTalkApiError).message).toBe('OIDC_TEST_DINGTALK_TOKEN_REJECTED');
    expect((error as DingTalkApiError).detail).toMatchObject({
      dingtalkCode: 'invalidParameter.idOrSecret.notFound',
      stage: 'token',
      status: 400,
    });
  });

  it('still fails closed when the error body carries no usable code', async () => {
    const opaque = setup(async () => response({ message: 'nope' }, { status: 500 }));
    const error = await exchangeDingTalkAuthorizationCode({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      code: 'bad',
      outbound: opaque,
    }).catch((cause: unknown) => cause);
    expect((error as DingTalkApiError).detail).toEqual({ stage: 'token', status: 500 });

    // HTTP 200 with a body that is not a token response.
    const tokenless = setup(async () => response({ corpId: 'ding42' }));
    const shapeError = await exchangeDingTalkAuthorizationCode({
      clientId: 'app-key',
      clientSecret: 'app-secret',
      code: 'bad',
      outbound: tokenless,
    }).catch((cause: unknown) => cause);
    expect((shapeError as DingTalkApiError).message).toBe(
      'PLATFORM_DINGTALK_TOKEN_RESPONSE_INVALID',
    );
    expect((shapeError as DingTalkApiError).detail.stage).toBe('token');
  });
});

describe('DingTalk profile read', () => {
  it('authenticates with the DingTalk header instead of an OIDC bearer token', async () => {
    const transport = vi.fn<PinnedTransport>(async (request) => {
      expect(request.url.toString()).toBe(DINGTALK_USERINFO_ENDPOINT);
      expect(request.method).toBe('GET');
      expect(request.headers).toEqual({
        'Accept': 'application/json',
        'x-acs-dingtalk-access-token': 'access-token',
      });
      expect(request.headers).not.toHaveProperty('Authorization');
      return response({
        avatarUrl: 'https://cdn.example.test/a.png',
        nick: '张三',
        unionId: 'u-1',
      });
    });
    const outbound = setup(transport);

    await expect(
      fetchDingTalkUserProfile({ accessToken: 'access-token', outbound }),
    ).resolves.toMatchObject({ nick: '张三', unionId: 'u-1' });
  });

  it('fails closed on a non-JSON or error response', async () => {
    const outbound = setup(async () =>
      response('nope', { headers: { 'content-type': 'text/html' } }),
    );
    await expect(
      fetchDingTalkUserProfile({ accessToken: 'access-token', outbound }),
    ).rejects.toThrow('PLATFORM_DINGTALK_USERINFO_INVALID');
  });
});

describe('DingTalk organisation name lookup', () => {
  const creds = { clientId: 'app-key', clientSecret: 'app-secret', corpId: 'ding42' };

  it('resolves the name via the app access token and the org auth-info endpoint', async () => {
    const transport = vi.fn<PinnedTransport>(async (request) => {
      const url = request.url.toString();
      if (url === DINGTALK_APP_TOKEN_ENDPOINT) {
        expect(request.method).toBe('POST');
        expect(JSON.parse(String(request.body))).toEqual({
          appKey: 'app-key',
          appSecret: 'app-secret',
        });
        return response({ accessToken: 'app-token', expireIn: 7200 });
      }
      expect(url).toBe(`${DINGTALK_ORG_AUTH_INFO_ENDPOINT}?targetCorpId=ding42`);
      expect(request.headers).toMatchObject({ 'x-acs-dingtalk-access-token': 'app-token' });
      return response({ corpName: '  示例科技有限公司 ', licenseOrgName: 'x' });
    });

    await expect(fetchDingTalkCorpName({ ...creds, outbound: setup(transport) })).resolves.toEqual({
      corpName: '示例科技有限公司',
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('reports the missing permission DingTalk names instead of failing', async () => {
    const outbound = setup(async (request) =>
      request.url.toString() === DINGTALK_APP_TOKEN_ENDPOINT
        ? response({ accessToken: 'app-token' })
        : response(
            {
              accessdenieddetail: { requiredScopes: ['Contact.Org.Read'] },
              code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
              message: 'secret-bearing free text must not travel',
            },
            { status: 403, statusText: 'Forbidden' },
          ),
    );
    await expect(fetchDingTalkCorpName({ ...creds, outbound })).resolves.toEqual({
      missingScope: 'Contact.Org.Read',
      reason: 'forbidden',
    });
  });

  it('falls back to Contact.Org.Read when a 403 does not echo requiredScopes', async () => {
    const outbound = setup(async (request) =>
      request.url.toString() === DINGTALK_APP_TOKEN_ENDPOINT
        ? response({ accessToken: 'app-token' })
        : response({ code: 'Forbidden.AccessDenied' }, { status: 403, statusText: 'Forbidden' }),
    );
    await expect(fetchDingTalkCorpName({ ...creds, outbound })).resolves.toEqual({
      missingScope: DINGTALK_ORG_READ_SCOPE,
      reason: 'forbidden',
    });
  });

  it.each([
    ['orgName', { orgName: '  示例科技有限公司 ' }],
    ['organizationName', { organizationName: '示例科技有限公司' }],
    ['licenseOrgName', { licenseOrgName: '示例科技有限公司' }],
    ['result.corpName', { result: { corpName: '示例科技有限公司' } }],
  ])('accepts the organisation name from %s', async (_label, body) => {
    const outbound = setup(async (request) =>
      request.url.toString() === DINGTALK_APP_TOKEN_ENDPOINT
        ? response({ accessToken: 'app-token' })
        : response(body),
    );
    await expect(fetchDingTalkCorpName({ ...creds, outbound })).resolves.toEqual({
      corpName: '示例科技有限公司',
    });
  });

  it('never throws — a rejected app token or a network failure yields no name', async () => {
    const rejected = setup(async () =>
      response({ code: 'invalidParameter.idOrSecret.notFound' }, { status: 400 }),
    );
    await expect(fetchDingTalkCorpName({ ...creds, outbound: rejected })).resolves.toEqual({
      reason: 'app_token_rejected',
    });
    const failing = setup(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetchDingTalkCorpName({ ...creds, outbound: failing })).resolves.toEqual({
      reason: 'network',
    });
  });
});

describe('DingTalk claim projection', () => {
  const claims = (profile: Record<string, unknown>) =>
    toDingTalkClaims(profile, { providerKey: 'dingtalk' });

  it('uses unionId as the stable subject and maps nick/avatar', () => {
    const result = claims({
      avatarUrl: 'https://cdn.example.test/a.png',
      nick: '张三',
      openId: 'o-1',
      unionId: 'u-1',
    });
    expect(result.sub).toBe('u-1');
    expect(result.id).toBe('u-1');
    expect(result.nick).toBe('张三');
    expect(result.avatarUrl).toBe('https://cdn.example.test/a.png');
  });

  it('rejects a profile without a unionId instead of falling back to the app-scoped openId', () => {
    expect(() => claims({ nick: '李四', openId: 'o-1' })).toThrow(
      'PLATFORM_DINGTALK_SUBJECT_MISSING',
    );
    expect(() =>
      toDingTalkClaims(
        { nick: '李四', openId: 'o-1' },
        { errorCode: 'OIDC_TEST_CLAIM_VALIDATION_FAILED', providerKey: 'dingtalk' },
      ),
    ).toThrow('OIDC_TEST_CLAIM_VALIDATION_FAILED');
  });

  it('synthesizes a provider-namespaced email when DingTalk exposes none', () => {
    expect(claims({ nick: '张三', unionId: 'u-1' }).email).toBe('u-1@dingtalk.dingtalk.sso');
    expect(
      toDingTalkClaims({ nick: '张三', unionId: 'u-1' }, { providerKey: 'ding-second' }).email,
    ).toBe('u-1@ding-second.dingtalk.sso');
    expect(claims({ nick: '张三', unionId: 'u-1' }).emailVerified).toBe(false);
  });

  it('normalises a real email to lowercase and falls back to the subject for the nick', () => {
    expect(claims({ email: '  Zhang.San@Example.COM ', nick: '张三', unionId: 'u-1' }).email).toBe(
      'zhang.san@example.com',
    );
    expect(claims({ unionId: 'u-1' }).nick).toBe('u-1');
  });
});

describe('synthetic identity email namespace', () => {
  // Every provider key the DingTalk write boundary accepts, plus the shapes it must reject.
  const permittedKeys = ['dingtalk', 'd', 'ding-talk', 'corp2', 'a-b-c', '0ding', 'x'.repeat(63)];
  const rejectedKeys = ['corp_sso', 'corp.sso', '-ding', 'ding-', 'DingTalk', '', 'x'.repeat(64)];

  it('round-trips every permitted provider key through builder → matcher → email validation', () => {
    for (const providerKey of permittedKeys) {
      expect(isValidDingTalkProviderKey(providerKey), providerKey).toBe(true);
      const email = buildDingTalkSyntheticEmail(providerKey, 'union-1');
      // The namespace invariant: everything the builder emits is classified reserved…
      expect(isReservedSyntheticIdentityEmail(email), email).toBe(true);
      // …and is a syntactically valid address, so runtime claim validation accepts it.
      expect(z.string().email().safeParse(email).success, email).toBe(true);
    }
  });

  it('rejects provider keys that would build an invalid address', () => {
    for (const providerKey of rejectedKeys) {
      expect(isValidDingTalkProviderKey(providerKey), providerKey).toBe(false);
    }
    // Historically `corp_sso` produced an address the matcher missed AND zod rejected.
    const legacy = buildDingTalkSyntheticEmail('corp_sso', 'union-1');
    expect(isReservedSyntheticIdentityEmail(legacy)).toBe(true);
    expect(z.string().email().safeParse(legacy).success).toBe(false);
  });

  it('classifies the root domain and any sub-domain, and nothing else', () => {
    for (const email of [
      'u@dingtalk.sso',
      'u@corp.dingtalk.sso',
      'u@corp_sso.dingtalk.sso',
      'u@a.b.c.dingtalk.sso',
      '  U@DINGTALK.SSO  ',
    ]) {
      expect(isReservedSyntheticIdentityEmail(email), email).toBe(true);
    }
    for (const email of [
      'ada@example.test',
      'ada@dingtalk.example.com',
      'ada@notdingtalk.sso',
      'ada@xdingtalk.sso',
      'dingtalk.sso',
      '@dingtalk.sso',
      null,
      undefined,
    ]) {
      expect(isReservedSyntheticIdentityEmail(email as string), String(email)).toBe(false);
    }
  });
});
