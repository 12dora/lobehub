// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';
import { PLATFORM_MASTER_KEY_ENV } from '@/server/enterprise/security/secret';

import { createIdentityProviderSecurityFoundation } from './factory';

const unusedDb = null as unknown as LobeChatDatabase;

describe('createIdentityProviderSecurityFoundation', () => {
  it('is a no-op when the database OIDC flag is off', () => {
    expect(createIdentityProviderSecurityFoundation(unusedDb, {})).toBeNull();
  });

  it('fails closed before constructing dependencies when the flag is on without a master key', () => {
    expect(() =>
      createIdentityProviderSecurityFoundation(unusedDb, { ENABLE_DATABASE_OIDC: '1' }),
    ).toThrow();
  });

  it('tightens the OIDC network boundary to public-only when private IPs are disabled', async () => {
    const transport = vi.fn();
    const foundation = createIdentityProviderSecurityFoundation(
      unusedDb,
      {
        ENABLE_DATABASE_OIDC: '1',
        SSRF_ALLOW_PRIVATE_IP_ADDRESS: '0',
        [PLATFORM_MASTER_KEY_ENV]: Buffer.alloc(32, 7).toString('base64'),
      },
      {
        resolve: async () => [{ address: '10.0.0.1', family: 4 }],
        transport,
      },
    );
    await expect(
      foundation?.discovery.validateNetwork('https://login.example.com/application/o/work/'),
    ).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('allows internal-network issuers to reach the network layer by default (G-07 allow-private)', async () => {
    // Unset SSRF_ALLOW_PRIVATE_IP_ADDRESS → allow-private: an issuer whose DNS resolves to a
    // private IP is not pre-blocked, so discovery reaches the transport (an internal IdP).
    const transport = vi.fn(async () => ({
      body: Buffer.from('{}'),
      headers: { 'content-type': 'application/json; charset=utf-8' },
      status: 200,
      statusText: 'OK',
    }));
    const foundation = createIdentityProviderSecurityFoundation(
      unusedDb,
      {
        ENABLE_DATABASE_OIDC: '1',
        [PLATFORM_MASTER_KEY_ENV]: Buffer.alloc(32, 7).toString('base64'),
      },
      {
        resolve: async () => [{ address: '10.0.0.1', family: 4 }],
        transport,
      },
    );
    await foundation?.discovery
      .discover('https://login.example.com/application/o/work/')
      .catch(() => undefined);
    expect(transport).toHaveBeenCalled();
  });
});
