// @vitest-environment node
/**
 * Provider CREATE materializes the builtin card's default-enabled models.
 *
 * Before this, a builtin provider was created with ZERO model rows while the admin model list
 * (a merge of platform rows and the model-bank catalog) already drew those models with the
 * toggle ON, and the connectivity check answered "check model not enabled" until the operator
 * toggled every model off and on again. These pin the seeding, its metadata, its scope
 * (builtin only), its idempotency, and the check working on the very first connect.
 */
import { listDefaultEnabledBuiltinModels } from '@lobechat/utils/builtinModelDefaults';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import {
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
  platformSettingPolicies,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { type KeyProvider, PlatformSecretService } from '@/server/enterprise/security/secret';

import { AiCatalogAdminService } from './adminService';
import type { AiConnectionProbe } from './connectionTestService';

const db: LobeChatDatabase = await getTestDB();
const keyProvider: KeyProvider = {
  getKek: async () => ({ key: new Uint8Array(32).fill(23), keyId: 'builtin-defaults' }),
  providerId: 'test',
};

/** Append-only audit rows cannot be DELETE'd (0145); TRUNCATE bypasses the row trigger. */
const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformSettingPolicies},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanup();
});
afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const createService = (connectionProbe: AiConnectionProbe = async () => {}) =>
  new AiCatalogAdminService(db, new PlatformSecretService({ keyProvider }), { connectionProbe });

/**
 * A shared-account connect stores only an access token: without a refresh token the shared
 * OAuth refresh short-circuits, so nothing in these tests reaches the network.
 */
const connectChatgptWeb = (service: AiCatalogAdminService) =>
  service.applyProviderImmediate('admin', {
    checkModel: 'auto',
    displayName: 'ChatGPT Web',
    enabled: true,
    mode: 'create',
    providerKey: 'chatgptweb',
    reason: 'connect the shared ChatGPT Web account',
    secret: { operation: 'replace', value: { oauthAccessToken: 'shared-access-token' } },
    source: 'builtin',
  });

describe('AiCatalogAdminService builtin default-model materialization', () => {
  it('materializes the card default-enabled models on a builtin provider create', async () => {
    const service = createService();
    const result = await connectChatgptWeb(service);

    const keys = result.draft.models.map((model) => model.modelKey).sort();
    // Set equality against model-bank keeps this honest when the card changes...
    expect(keys).toEqual(
      listDefaultEnabledBuiltinModels('chatgptweb')
        .map((item) => item.modelKey)
        .sort(),
    );
    // ...and the named keys pin today's contract, including the IMAGE model: an image card
    // the catalog enables is exactly as visibly "enabled" in the admin list as a chat one.
    expect(keys).toEqual(
      expect.arrayContaining([
        'auto',
        'gpt-5-6',
        'gpt-5-6-instant',
        'gpt-5-6-pro',
        'gpt-5-6-thinking',
        'gpt-image-2',
      ]),
    );
    expect(result.draft.models.every((model) => model.enabled)).toBe(true);
    expect(result.draft.models.find((model) => model.modelKey === 'gpt-image-2')?.type).toBe(
      'image',
    );

    // Card metadata, not an empty stub — the whole point of reusing the model-bank payload.
    const auto = result.draft.models.find((model) => model.modelKey === 'auto')!;
    expect(auto).toMatchObject({
      contextWindowTokens: 128_000,
      displayName: 'Auto (ChatGPT Web)',
      type: 'chat',
    });
    expect(auto.abilities).toMatchObject({ reasoning: true, vision: true });
    expect(auto.settings).toMatchObject({ searchProvider: 'chatgptweb' });

    // Card order survives, so the list reads the way the catalog presents it.
    expect(result.draft.models[0]!.modelKey).toBe('auto');
  });

  it('audits every seeded row as a create tagged with its builtin origin', async () => {
    const service = createService();
    await connectChatgptWeb(service);

    const audits = await db.select().from(platformAuditLogs);
    const seeded = audits.filter(
      (row) =>
        row.action === 'admin.aiModels.create' &&
        (row.afterDiff as { materializedFrom?: string } | null)?.materializedFrom ===
          'builtin_card',
    );
    expect(seeded).toHaveLength(listDefaultEnabledBuiltinModels('chatgptweb').length);
    expect(seeded.every((row) => row.result === 'success')).toBe(true);
  });

  it('leaves a non-builtin provider untouched', async () => {
    const service = createService();
    // Same providerKey as a builtin card: it is `source`, not the key, that decides.
    const result = await service.applyProviderImmediate('admin', {
      displayName: 'Self-hosted',
      enabled: true,
      mode: 'create',
      providerKey: 'chatgptweb',
      reason: 'create a custom provider',
      secret: { operation: 'replace', value: 'seed-key' },
      settings: { sdkType: 'openai' },
      source: 'custom',
    });
    expect(result.draft.models).toEqual([]);
    expect(await db.select().from(platformAiModels)).toEqual([]);
  });

  it('seeds nothing for a builtin provider whose card enables no model by default', async () => {
    const service = createService();
    // `nvidia` ships a catalog with nothing enabled out of the box — there is nothing honest
    // to seed, and an empty stub row would be worse than no row.
    expect(listDefaultEnabledBuiltinModels('nvidia')).toEqual([]);
    const result = await service.applyProviderImmediate('admin', {
      displayName: 'NVIDIA',
      enabled: true,
      mode: 'create',
      providerKey: 'nvidia',
      reason: 'create a builtin provider with no default models',
      secret: { operation: 'replace', value: 'seed-key' },
      source: 'builtin',
    });
    expect(result.draft.models).toEqual([]);
  });

  it('is idempotent: a second materialization adds nothing and rewrites nothing', async () => {
    const service = createService();
    const created = await connectChatgptWeb(service);
    const before = await db.select().from(platformAiModels);

    // The protected seam, reached directly: provider create can only happen once per key,
    // so the skip-existing branch has no other way to be exercised.
    const seed = (
      service as unknown as {
        materializeBuiltinDefaultModels: (
          actorUserId: string,
          params: { providerId: string; providerKey: string; reason: string },
        ) => Promise<{ materializedModelKeys: string[] }>;
      }
    ).materializeBuiltinDefaultModels;
    const again = await seed('admin', {
      providerId: created.draft.id,
      providerKey: 'chatgptweb',
      reason: 'seed again',
    });

    expect(again.materializedModelKeys).toEqual([]);
    const after = await db.select().from(platformAiModels);
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it('lets the connectivity check reach the probe on the very first connect', async () => {
    let probedModel: string | undefined;
    const service = createService(async (params) => {
      probedModel = params.model;
    });
    const created = await connectChatgptWeb(service);

    // Used to be `Check model not enabled`: the check model existed only in model-bank.
    const result = await service.testProvider('admin', {
      id: created.draft.id,
      reason: 'verify the shared account',
    });
    expect(result.status).toBe('success');
    expect(probedModel).toBe('auto');
  });
});
