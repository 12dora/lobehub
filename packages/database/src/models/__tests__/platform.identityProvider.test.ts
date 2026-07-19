// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformIdentityProviders, platformIdentityProviderSecrets } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformIdentityProviderModel } from '../platform/identityProvider';

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
});
