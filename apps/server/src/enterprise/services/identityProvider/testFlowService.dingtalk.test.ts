// @vitest-environment node
import { DINGTALK_IDENTITY_PROVIDER_ISSUER } from '@lobechat/types';
import { describe, expect, it, vi } from 'vitest';

import {
  type PinnedTransport,
  type PinnedTransportResponse,
  SafeOutboundHttpClient,
} from '../../security/outboundHttp';
import {
  DINGTALK_APP_TOKEN_ENDPOINT,
  DINGTALK_ORG_AUTH_INFO_ENDPOINT,
  DINGTALK_ORG_READ_SCOPE,
  DINGTALK_TOKEN_ENDPOINT,
  DINGTALK_USERINFO_ENDPOINT,
} from './kinds/dingtalk';
import { resolveDingTalkClaims } from './testFlowService';

const publicAddress = '93.184.216.34';

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

const tokenBody = { accessToken: 'user-token', corpId: 'ding42' };
const profileBody = { nick: 'Ada', unionId: 'u-1' };

const resolve = (outbound: SafeOutboundHttpClient) =>
  resolveDingTalkClaims({
    clientId: 'app-key',
    clientSecret: 'app-secret',
    code: 'auth-code',
    issuer: DINGTALK_IDENTITY_PROVIDER_ISSUER,
    outbound,
    providerKey: 'dingtalk',
  });

const transportFor = (input: {
  org?: PinnedTransportResponse;
  profile?: Record<string, unknown>;
}): PinnedTransport =>
  vi.fn<PinnedTransport>(async (request) => {
    const url = request.url.toString();
    if (url === DINGTALK_TOKEN_ENDPOINT) return response(tokenBody);
    if (url === DINGTALK_USERINFO_ENDPOINT) return response(input.profile ?? profileBody);
    if (url === DINGTALK_APP_TOKEN_ENDPOINT) return response({ accessToken: 'app-token' });
    expect(url).toBe(`${DINGTALK_ORG_AUTH_INFO_ENDPOINT}?targetCorpId=ding42`);
    return (
      input.org ??
      response(
        {
          accessdenieddetail: { requiredScopes: [DINGTALK_ORG_READ_SCOPE] },
          code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied',
        },
        { status: 403, statusText: 'Forbidden' },
      )
    );
  });

describe('resolveDingTalkClaims organisation name', () => {
  it('includes the org-lookup name when DingTalk returns one', async () => {
    const outbound = setup(transportFor({ org: response({ corpName: '  示例科技有限公司 ' }) }));
    await expect(resolve(outbound)).resolves.toMatchObject({
      dingtalk: { corpId: 'ding42', corpName: '示例科技有限公司', nick: 'Ada' },
    });
  });

  it('reports forbidden when the org lookup is refused', async () => {
    const outbound = setup(transportFor({}));
    await expect(resolve(outbound)).resolves.toMatchObject({
      dingtalk: {
        corpId: 'ding42',
        corpNameMissingScope: DINGTALK_ORG_READ_SCOPE,
        corpNameReason: 'forbidden',
        nick: 'Ada',
      },
    });
    expect((await resolve(outbound)).dingtalk).not.toHaveProperty('corpName');
  });

  it('falls back to the userinfo corpName when the org lookup is absent', async () => {
    const outbound = setup(
      transportFor({
        org: response({}),
        profile: { ...profileBody, corpName: '来自资料的企业' },
      }),
    );
    await expect(resolve(outbound)).resolves.toMatchObject({
      dingtalk: { corpId: 'ding42', corpName: '来自资料的企业', nick: 'Ada' },
    });
    expect((await resolve(outbound)).dingtalk).not.toHaveProperty('corpNameReason');
  });

  it('surfaces name_absent when neither the org lookup nor userinfo has a name', async () => {
    const outbound = setup(transportFor({ org: response({}) }));
    await expect(resolve(outbound)).resolves.toMatchObject({
      dingtalk: { corpId: 'ding42', corpNameReason: 'name_absent', nick: 'Ada' },
    });
    expect((await resolve(outbound)).dingtalk).not.toHaveProperty('corpName');
  });
});
