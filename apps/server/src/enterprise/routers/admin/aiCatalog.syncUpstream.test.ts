// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  platformResourceRevisions,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import * as ModelRuntime from '@/server/modules/ModelRuntime';
import * as PlatformAiRuntimeBridge from '@/server/modules/ModelRuntime/platformAiRuntimeBridge';

import { getEnterpriseErrorBody } from '../../guards/enterpriseErrors';
import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = {
  aiAdmin: 'b3-sync-ai-admin',
};

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

vi.mock('@/server/modules/ModelRuntime', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    initModelRuntimeWithUserPayload: vi.fn(),
  };
});

/**
 * The execution resolver is deliberately not the credential path here: it throws NOT_FOUND until
 * platform takeover is published, and an operator will reasonably sync before publishing. Mocking
 * it to throw turns a regression back onto it into a failing test rather than a 404 in production.
 *
 * It lives on the bridge module, not the ModelRuntime barrel — mocking the barrel would add a
 * property nothing imports and the assertion below would pass without proving anything.
 */
vi.mock('@/server/modules/ModelRuntime/platformAiRuntimeBridge', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    resolvePlatformAiExecutionConfig: vi.fn(() => {
      throw new Error('execution resolver must not be used for admin sync');
    }),
  };
});

const mockModels = vi.fn();

const cleanup = async () => {
  await db.execute(sql`
    TRUNCATE TABLE
      ${platformAuditLogs},
      ${platformResourceRevisions},
      ${platformAiModels},
      ${platformAiProviderSecrets},
      ${platformAiProviders},
      ${userRoles},
      ${rolePermissions},
      ${roles},
      ${permissions},
      ${users}
    RESTART IDENTITY CASCADE
  `);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 37).toString('base64'));
  mockModels.mockReset();
  vi.mocked(ModelRuntime.initModelRuntimeWithUserPayload).mockReset();
  vi.mocked(ModelRuntime.initModelRuntimeWithUserPayload).mockReturnValue({
    models: mockModels,
  } as never);
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const callerFor = async (
  userId: string,
  auth: Date | null | { authenticatedAt?: Date | null; authMethod?: 'api-key' | 'better-auth' } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) => {
  const resolved =
    auth instanceof Date || auth === null
      ? { authenticatedAt: auth, authMethod: 'better-auth' as const }
      : auth;
  return createCaller({
    ...(await createContextInner({
      authenticatedAt: resolved.authenticatedAt,
      authMethod: resolved.authMethod ?? 'better-auth',
      userId,
    })),
    serverDB: db,
  } as never);
};

const seedProvider = async (providerKey: string, secret?: string) => {
  const caller = await callerFor(ids.aiAdmin);
  const created = await caller.aiProviders.applyImmediate({
    displayName: providerKey,
    enabled: true,
    mode: 'create',
    providerKey,
    reason: 'seed provider',
    ...(secret === undefined ? {} : { secret: { operation: 'replace' as const, value: secret } }),
    settings: { sdkType: 'openai' },
    source: 'custom',
  });
  return { caller, providerId: created.draft.id, providerKey };
};

describe('admin.aiModels.syncUpstream', () => {
  it('creates new keys disabled, updates existing metadata, and writes one sync audit', async () => {
    const { caller, providerId, providerKey } = await seedProvider(
      'sync-happy',
      'seed-credential-sync-happy',
    );
    let detail = await caller.aiProviders.get({ id: providerId });
    await caller.aiModels.applyImmediate({
      displayName: 'Old Name',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'kept-enabled',
      operation: 'create',
      providerId,
      reason: 'seed existing',
      type: 'chat',
    });

    mockModels.mockResolvedValue([
      {
        contextWindowTokens: 128_000,
        displayName: 'Renamed',
        functionCall: true,
        id: 'kept-enabled',
        type: 'chat',
      },
      {
        displayName: 'Brand New',
        id: 'brand-new',
        type: 'chat',
        vision: true,
      },
    ]);

    const result = await caller.aiModels.syncUpstream({ providerId: providerKey });
    expect(result).toEqual({ created: 1, total: 2, updated: 1 });
    expect(PlatformAiRuntimeBridge.resolvePlatformAiExecutionConfig).not.toHaveBeenCalled();

    detail = await caller.aiProviders.get({ id: providerId });
    const kept = detail.draft.models.find((model) => model.modelKey === 'kept-enabled');
    const created = detail.draft.models.find((model) => model.modelKey === 'brand-new');
    expect(kept).toMatchObject({
      displayName: 'Renamed',
      enabled: true,
    });
    expect(created).toMatchObject({
      displayName: 'Brand New',
      enabled: false,
      type: 'chat',
    });

    const syncAudits = (await db.select().from(platformAuditLogs)).filter(
      (row) => row.action === 'admin.aiModels.syncUpstream' && row.result === 'success',
    );
    expect(syncAudits).toHaveLength(1);
    expect(syncAudits[0]?.afterDiff).toMatchObject({ created: 1, total: 2, updated: 1 });
  });

  it('keeps an existing enabled model enabled when upstream re-reports it', async () => {
    const { caller, providerId, providerKey } = await seedProvider(
      'sync-keep-enabled',
      'seed-credential-sync-keep',
    );
    const detail = await caller.aiProviders.get({ id: providerId });
    await caller.aiModels.applyImmediate({
      displayName: 'Live',
      enabled: true,
      expectedDraftToken: detail.draftToken,
      modelKey: 'live-model',
      operation: 'create',
      providerId,
      reason: 'seed live',
      type: 'chat',
    });

    mockModels.mockResolvedValue([{ displayName: 'Live', id: 'live-model', type: 'chat' }]);

    const result = await caller.aiModels.syncUpstream({ providerId: providerKey });
    expect(result).toEqual({ created: 0, total: 1, updated: 0 });

    const after = await caller.aiProviders.get({ id: providerId });
    expect(after.draft.models.find((model) => model.modelKey === 'live-model')).toMatchObject({
      displayName: 'Live',
      enabled: true,
    });
  });

  it('rejects a missing shared vault with a typed error and writes nothing', async () => {
    // supergrok has no env-key fallback — an empty platform vault is always incomplete.
    const caller = await callerFor(ids.aiAdmin);
    const created = await caller.aiProviders.applyImmediate({
      displayName: 'Grok',
      enabled: true,
      mode: 'create',
      providerKey: 'supergrok',
      reason: 'seed empty shared account',
      source: 'builtin',
    });
    const before = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, created.draft.id));

    await expect(caller.aiModels.syncUpstream({ providerId: 'supergrok' })).rejects.toSatisfy(
      (error: unknown) => {
        const body = getEnterpriseErrorBody(error);
        return body?.code === 'PLATFORM_CONFIG_VALIDATION_FAILED';
      },
    );
    expect(mockModels).not.toHaveBeenCalled();

    const after = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, created.draft.id));
    expect(after).toEqual(before);
  });

  it('rejects a runtime without an enumerator as cannot_enumerate', async () => {
    const { caller, providerId, providerKey } = await seedProvider(
      'sync-no-enum',
      'seed-credential-sync-no-enum',
    );
    mockModels.mockResolvedValue(undefined);

    await expect(caller.aiModels.syncUpstream({ providerId: providerKey })).rejects.toSatisfy(
      (error: unknown) => {
        const body = getEnterpriseErrorBody(error);
        return (
          body?.code === 'PLATFORM_INVALID_INPUT' && body.details?.reason === 'cannot_enumerate'
        );
      },
    );

    const models = await db
      .select()
      .from(platformAiModels)
      .where(eq(platformAiModels.providerId, providerId));
    expect(models).toEqual([]);
  });

  it('still syncs when platform takeover is not published', async () => {
    const { caller, providerKey } = await seedProvider(
      'sync-no-takeover',
      'seed-credential-sync-no-takeover',
    );
    mockModels.mockResolvedValue([{ displayName: 'Only', id: 'only', type: 'chat' }]);

    const result = await caller.aiModels.syncUpstream({ providerId: providerKey });
    expect(result).toEqual({ created: 1, total: 1, updated: 0 });
    expect(ModelRuntime.initModelRuntimeWithUserPayload).toHaveBeenCalled();
    expect(PlatformAiRuntimeBridge.resolvePlatformAiExecutionConfig).not.toHaveBeenCalled();
  });
});
