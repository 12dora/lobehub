// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformIdentityProviders, platformIdentityProviderSecrets } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PlatformIdentityProviderModel,
  toSafeIdentityProviderDraft,
} from '../platform/identityProvider';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformIdentityProviderModel(serverDB);

const cleanup = async () => {
  await serverDB.delete(platformIdentityProviderSecrets);
  await serverDB.delete(platformIdentityProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformIdentityProviderModel', () => {
  it('projects configured state without refs or encrypted material', async () => {
    const privateMarker = randomUUID();
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({
        displayName: 'Work',
        providerKey: 'work',
        secretFingerprint: 'a'.repeat(64),
        secretRef: `kms://platform-identity-providers/provider/${privateMarker}`,
        secretUpdatedAt: new Date('2026-07-19T00:00:00Z'),
      })
      .returning();

    const result = await model.prepareRevisionPayload(provider.id);
    expect(result?.secret).toEqual({
      configured: true,
      fingerprint: 'a'.repeat(64),
      updatedAt: new Date('2026-07-19T00:00:00Z'),
    });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(result).not.toHaveProperty('secretRef');
  });

  it('supports list, missing, and unconfigured safe projections', async () => {
    const [provider] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Unconfigured', providerKey: 'unconfigured' })
      .returning();
    await expect(model.get('missing')).resolves.toBeUndefined();
    await expect(model.prepareRevisionPayload('missing')).resolves.toBeNull();
    await expect(model.list()).resolves.toEqual([
      expect.objectContaining({
        id: provider.id,
        secret: { configured: false, fingerprint: null, updatedAt: null },
      }),
    ]);
  });

  it('fails closed when untrusted persisted config contains extra or credential material', async () => {
    const [row] = await serverDB
      .insert(platformIdentityProviders)
      .values({ displayName: 'Work', providerKey: 'work' })
      .returning();
    for (const claim of ['clientSecret', 'apiKey', 'accessToken']) {
      expect(() =>
        toSafeIdentityProviderDraft({
          ...row,
          claimMapping: { ...row.claimMapping, email: [claim] },
        }),
      ).toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_PERSISTED_CONFIG');
    }
    expect(() =>
      toSafeIdentityProviderDraft({
        ...row,
        groupRoleMapping: { nested: { apiKey: 'sk-abcdefgh' } } as unknown as Record<
          string,
          string
        >,
      }),
    ).toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_PERSISTED_CONFIG');
    expect(() =>
      toSafeIdentityProviderDraft({
        ...row,
        icon: 'https://example.com/icon?accessToken=value',
      }),
    ).toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_PERSISTED_CONFIG');
    for (const malicious of [
      '-----BEGIN PRIVATE KEY-----\nnot-a-real-key',
      'AKIA1234567890ABCDEF',
      `AIza${'A'.repeat(35)}`,
    ]) {
      expect(() =>
        toSafeIdentityProviderDraft({
          ...row,
          groupRoleMapping: { nested: { label: malicious } } as unknown as Record<string, string>,
        }),
      ).toThrow('PLATFORM_IDENTITY_PROVIDER_INVALID_PERSISTED_CONFIG');
    }
  });
});
