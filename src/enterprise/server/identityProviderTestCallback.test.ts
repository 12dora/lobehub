// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { createAdminIdentityProviderRuntime } from '@/server/enterprise/routers/admin/identityProvidersSupport';

import { handleIdentityProviderTestCallback } from './identityProviderTestCallback';

vi.mock('@/server/enterprise/routers/admin/identityProvidersSupport', () => ({
  createAdminIdentityProviderRuntime: vi.fn(),
}));

const unusedDb = {} as LobeChatDatabase;

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('handleIdentityProviderTestCallback', () => {
  it('is a no-runtime terminal page while the feature is disabled', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        'https://app.example.test/oauth/identity-provider/test/callback?code=x&state=y',
      ),
      unusedDb,
    );
    expect(createAdminIdentityProviderRuntime).not.toHaveBeenCalled();
    expect(await response.text()).toContain('Test failed');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('terminally abandons provider errors without reflecting attacker strings', async () => {
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    const abandon = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createAdminIdentityProviderRuntime).mockReturnValue({
      admin: {} as never,
      test: { abandon } as never,
    });
    const attacker = '</script><script>alert(1)</script>';
    const response = await handleIdentityProviderTestCallback(
      new NextRequest(
        `https://app.example.test/oauth/identity-provider/test/callback?state=safe&error=denied&error_description=${encodeURIComponent(attacker)}`,
      ),
      unusedDb,
    );
    expect(abandon).toHaveBeenCalledWith('safe');
    expect(await response.text()).not.toContain(attacker);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });
});
