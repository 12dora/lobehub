// @vitest-environment node
import {
  GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE,
  PLATFORM_IDENTITY_PROVIDER_STATUSES,
} from '@lobechat/types';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformIdentityProviders, platformIdentityProviderSecrets } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformIdentityProviderRepository } from '.';

const serverDB: LobeChatDatabase = await getTestDB();
const repository = new PlatformIdentityProviderRepository(serverDB);

const cleanup = async () => {
  await serverDB.delete(platformIdentityProviderSecrets);
  await serverDB.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformIdentityProviderRepository', () => {
  it('enforces stable provider-key uniqueness', async () => {
    await repository.create({ displayName: 'First', providerKey: 'work' });
    await expect(
      repository.create({ displayName: 'Second', providerKey: 'work' }),
    ).rejects.toThrow();
  });

  it('persists every lifecycle status and structured defaults', async () => {
    for (const [index, status] of PLATFORM_IDENTITY_PROVIDER_STATUSES.entries()) {
      await repository.create({
        displayName: status,
        providerKey: `status-${index}`,
        status,
      });
    }
    const rows = await repository.list();
    expect(rows.map((row) => row.status).sort()).toEqual(
      [...PLATFORM_IDENTITY_PROVIDER_STATUSES].sort(),
    );
    expect(rows[0]).toMatchObject({
      claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
      scopes: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes,
      type: 'generic_oidc',
    });
  });

  it('rejects invalid status and secret-bearing claim mapping at the database boundary', async () => {
    await expect(
      serverDB.execute(sql`
        INSERT INTO ${platformIdentityProviders} (id, provider_key, display_name, status)
        VALUES ('invalid-status', 'invalid-status', 'Invalid', 'unknown')
      `),
    ).rejects.toThrow();
    await expect(
      serverDB.execute(sql`
        INSERT INTO ${platformIdentityProviders} (id, provider_key, display_name, claim_mapping)
        VALUES (
          'invalid-claim',
          'invalid-claim',
          'Invalid',
          '{"name":["name"],"subject":["sub"],"secret":["forbidden"]}'::jsonb
        )
      `),
    ).rejects.toThrow();
    await expect(
      serverDB.execute(sql`
        INSERT INTO ${platformIdentityProviders} (id, provider_key, display_name, use_pkce)
        VALUES ('invalid-pkce', 'invalid-pkce', 'Invalid', false)
      `),
    ).rejects.toThrow();
    await expect(
      serverDB.execute(sql`
        INSERT INTO ${platformIdentityProviders} (id, provider_key, display_name, claim_mapping)
        VALUES (
          'invalid-array',
          'invalid-array',
          'Invalid',
          '{"dingtalkTitle":[],"dingtalkUserId":[],"email":[7],"name":["name"],"picture":[],"subject":["sub"]}'::jsonb
        )
      `),
    ).rejects.toThrow();
  });
});
