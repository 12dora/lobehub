// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAiModels, platformAiProviders } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAiCatalogModel } from '../platform/aiCatalog';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAiCatalogModel(serverDB);

const cleanup = async () => {
  await serverDB.delete(platformAiModels);
  await serverDB.delete(platformAiProviders);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAiCatalogModel', () => {
  it('returns an aggregate draft without encrypted secret material', async () => {
    const [provider] = await serverDB
      .insert(platformAiProviders)
      .values({
        displayName: 'Alpha',
        encryptedKeyVaults: 'aihub.secret.v1.never-return-this',
        providerKey: 'alpha',
        secretFingerprint: 'sha256:safe',
        secretUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      })
      .returning();
    await serverDB.insert(platformAiModels).values({
      contextWindowTokens: 128_000,
      enabled: true,
      modelKey: 'chat',
      providerId: provider.id,
    });

    const result = await model.getProvider(provider.id);
    expect(result).toMatchObject({
      models: [{ contextWindowTokens: 128_000, modelKey: 'chat' }],
      providerKey: 'alpha',
      secret: { configured: true, fingerprint: 'sha256:safe' },
    });
    expect(JSON.stringify(result)).not.toContain('never-return-this');
    expect(result).not.toHaveProperty('encryptedKeyVaults');
  });

  it('prepares a revision payload with secret metadata only', async () => {
    const [provider] = await serverDB
      .insert(platformAiProviders)
      .values({
        displayName: 'Alpha',
        encryptedKeyVaults: 'ciphertext',
        providerKey: 'alpha',
        secretFingerprint: 'fingerprint',
      })
      .returning();
    const payload = await model.prepareRevisionPayload(provider.id);
    expect(payload?.provider).toMatchObject({
      secretConfigured: true,
      secretFingerprint: 'fingerprint',
    });
    expect(JSON.stringify(payload)).not.toContain('ciphertext');
  });
});
