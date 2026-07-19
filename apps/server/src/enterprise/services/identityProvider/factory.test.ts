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

  it('always constructs the OIDC network boundary in public-only mode', async () => {
    const transport = vi.fn();
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
    await expect(
      foundation?.discovery.validateNetwork('https://login.example.com/application/o/work/'),
    ).rejects.toMatchObject({ code: 'OIDC_NETWORK_BLOCKED' });
    expect(transport).not.toHaveBeenCalled();
  });
});
