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

  it('never exposes retained legacy columns through create/get/getByKey/list', async () => {
    const discoveryMarker = 'https://legacy-marker.example/discovery';
    const encryptedMarker = 'legacy-ciphertext-marker';
    const created = await repository.create({ displayName: 'Created', providerKey: 'created' });
    await serverDB.insert(platformIdentityProviders).values({
      displayName: 'Legacy',
      legacyDiscoveryUrl: discoveryMarker,
      legacyEncryptedClientSecret: encryptedMarker,
      migrationRequired: true,
      providerKey: 'legacy',
    });

    const results = [
      created,
      await repository.get(created.id),
      await repository.getByKey('legacy'),
      ...(await repository.list()),
    ];
    for (const result of results) {
      expect(result).not.toHaveProperty('legacyDiscoveryUrl');
      expect(result).not.toHaveProperty('legacyEncryptedClientSecret');
      expect(JSON.stringify(result)).not.toContain(discoveryMarker);
      expect(JSON.stringify(result)).not.toContain(encryptedMarker);
    }
    await expect(
      repository.create({
        displayName: 'Forbidden',
        legacyEncryptedClientSecret: encryptedMarker,
        providerKey: 'forbidden',
      } as never),
    ).rejects.toThrow('PLATFORM_IDENTITY_PROVIDER_LEGACY_FIELDS_FORBIDDEN');
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

  it('listPage treats %, _, and \\ as literal characters (DB-010)', async () => {
    await repository.create({ displayName: 'Percent % Provider', providerKey: 'pct-provider' });
    await repository.create({ displayName: 'Under_score Provider', providerKey: 'us-provider' });
    await repository.create({ displayName: 'Back\\slash Provider', providerKey: 'bs-provider' });
    await repository.create({ displayName: 'Normal Provider', providerKey: 'normal-provider' });

    // Bare `%` must not match everything — only rows whose display/key contains a percent.
    const percent = await repository.listPage({ limit: 20, query: '%' });
    expect(percent.items.map((r) => r.providerKey)).toEqual(['pct-provider']);

    const underscore = await repository.listPage({ limit: 20, query: '_' });
    expect(underscore.items.map((r) => r.providerKey)).toEqual(['us-provider']);

    const backslash = await repository.listPage({ limit: 20, query: '\\' });
    expect(backslash.items.map((r) => r.providerKey)).toEqual(['bs-provider']);

    // Case-insensitive contains still works for normal input.
    const normal = await repository.listPage({ limit: 20, query: 'normal' });
    expect(normal.items.map((r) => r.providerKey)).toEqual(['normal-provider']);
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
