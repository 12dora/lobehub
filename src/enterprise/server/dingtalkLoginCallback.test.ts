// @vitest-environment node
import { buildDingTalkLoginCallbackUrl } from '@lobechat/types';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDingTalkLoginCallback } from './dingtalkLoginCallback';

vi.mock('@/envs/app', () => ({ appEnv: { APP_URL: 'https://app.example.test' } }));

const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/server/enterprise/featureFlags', () => ({
  parseEnterpriseFeatureFlags: () => ({ ENABLE_DATABASE_OIDC: flags.enabled }),
}));

const artifact = vi.hoisted(() => ({
  databaseProviders: [] as { providerKey: string; type: string }[],
}));
vi.mock('@/server/enterprise/services/identityProvider/startupArtifact', () => ({
  getIdentityProviderRuntimeArtifact: () => artifact,
}));

const call = (url: string, providerKey = 'dingtalk') =>
  handleDingTalkLoginCallback(new NextRequest(new Request(url)), {
    params: Promise.resolve({ providerKey }),
  });

describe('DingTalk login callback shim', () => {
  beforeEach(() => {
    flags.enabled = true;
    artifact.databaseProviders = [{ providerKey: 'dingtalk', type: 'dingtalk' }];
  });

  it('publishes the redirect URL an administrator registers with DingTalk', () => {
    expect(buildDingTalkLoginCallbackUrl('https://app.example.test', 'dingtalk')).toBe(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk',
    );
  });

  it('rewrites authCode to code and forwards to the Better Auth callback', async () => {
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&state=S-1',
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    // Same origin, so the signed state cookie is re-sent to Better Auth.
    expect(location.origin).toBe('https://app.example.test');
    expect(location.pathname).toBe('/api/auth/oauth2/callback/dingtalk');
    expect(location.searchParams.get('code')).toBe('AC-1');
    expect(location.searchParams.get('state')).toBe('S-1');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts a standard `code` too, and prefers authCode when DingTalk sends both', async () => {
    const standard = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?code=C-1&state=S-1',
    );
    expect(new URL(standard.headers.get('location')!).searchParams.get('code')).toBe('C-1');

    const both = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&code=C-1&state=S-1',
    );
    expect(new URL(both.headers.get('location')!).searchParams.get('code')).toBe('AC-1');
  });

  it('forwards an authorization error so Better Auth can fail the flow', async () => {
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?state=S-1&error=access_denied&error_description=nope',
    );
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('error_description')).toBe('nope');
    expect(location.searchParams.get('code')).toBeNull();
  });

  it('drops every parameter outside the OAuth authorization-response set', async () => {
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&state=S-1&callbackURL=https%3A%2F%2Fevil.example&newUserCallbackURL=x&corpId=ding42',
    );
    const location = new URL(response.headers.get('location')!);
    expect(location.searchParams.get('callbackURL')).toBeNull();
    expect(location.searchParams.get('newUserCallbackURL')).toBeNull();
    expect(location.searchParams.get('corpId')).toBeNull();
    expect([...location.searchParams.keys()].toSorted()).toEqual(['code', 'state']);
  });

  it('404s for a syntactically valid key that is not an active provider', async () => {
    artifact.databaseProviders = [{ providerKey: 'dingtalk', type: 'dingtalk' }];
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/unknown?authCode=AC-1&state=S-1',
      'unknown',
    );
    expect(response.status).toBe(404);
  });

  it('404s for a known provider of another kind, whose callback expects a real `code`', async () => {
    artifact.databaseProviders = [{ providerKey: 'corp-oidc', type: 'generic_oidc' }];
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/corp-oidc?authCode=AC-1&state=S-1',
      'corp-oidc',
    );
    expect(response.status).toBe(404);
  });

  it('404s while the startup artifact holds no provider at all', async () => {
    artifact.databaseProviders = [];
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&state=S-1',
    );
    expect(response.status).toBe(404);
  });

  it('cannot be used as an open redirect and rejects a malformed provider key', async () => {
    // The target is always built from APP_URL, so a hostile provider key cannot escape.
    for (const providerKey of ['../../evil', 'https://evil.example', 'UPPER', '']) {
      const response = await call(
        'https://app.example.test/oauth/identity-provider/dingtalk/x?authCode=AC-1&state=S-1',
        providerKey,
      );
      expect(response.status, providerKey).toBe(404);
    }
  });

  it('is inert when database identity providers are disabled', async () => {
    flags.enabled = false;
    const response = await call(
      'https://app.example.test/oauth/identity-provider/dingtalk/dingtalk?authCode=AC-1&state=S-1',
    );
    expect(response.status).toBe(404);
  });
});
