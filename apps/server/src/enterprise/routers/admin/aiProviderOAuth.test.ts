// @vitest-environment node
/**
 * admin.aiProviderOAuth — shared platform device-flow connection.
 * Covers provider admission, the pending/no-write path, the vault written on
 * success, and the presence-only projection of the status query.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAiModels,
  platformAiProviders,
  platformAiProviderSecrets,
  platformAuditLogs,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';

import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminRouter } from '../admin';
import type * as AiCatalogSupport from './aiCatalogSupport';

const oauthService = vi.hoisted(() => ({
  initiateDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

vi.mock('@/server/services/oauthDeviceFlow/providers/githubCopilot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOAuthService: vi.fn(() => oauthService),
}));

/**
 * Service methods are instance-level arrow properties, so the persistence seam is
 * swapped on the freshly built service rather than on a prototype.
 */
const serviceSeam = vi.hoisted(() => ({
  applyProviderImmediate: null as ReturnType<typeof vi.fn> | null,
}));

vi.mock('./aiCatalogSupport', async (importOriginal) => {
  const actual = await importOriginal<typeof AiCatalogSupport>();
  return {
    ...actual,
    createService: (database: Parameters<typeof actual.createService>[0]) => {
      const service = actual.createService(database);
      if (serviceSeam.applyProviderImmediate) {
        service.applyProviderImmediate = serviceSeam.applyProviderImmediate as never;
      }
      return service;
    },
  };
});

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = { aiAdmin: 'oauth-shared-ai-admin' };

const ACCESS_TOKEN = 'shared-access-token-value';
const REFRESH_TOKEN = 'shared-refresh-token-value';
const ACCOUNT_ID = 'acct-1234567890';

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  await deletePlatformAuditLogsForTest(db, { actorUserIds: Object.values(ids) });
  const ownedProviders = await db.select({ id: platformAiProviders.id }).from(platformAiProviders);
  await deletePlatformResourceRevisionsForTest(db, {
    resourceIds: ownedProviders.map((row) => row.id),
    resourceType: 'provider',
  });
  await db.delete(platformAiModels);
  await db.delete(platformAiProviderSecrets);
  await db.delete(platformAiProviders);
  await db.delete(userRoles);
  await db.delete(rolePermissions);
  await db.delete(roles);
  await db.delete(permissions);
  await db.delete(users);
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 41).toString('base64'));
  oauthService.initiateDeviceCode.mockReset();
  oauthService.pollForToken.mockReset();
  serviceSeam.applyProviderImmediate = null;
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (
  auth: { authenticatedAt: Date | null; authMethod: 'api-key' | 'better-auth' } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: auth.authenticatedAt,
      authMethod: auth.authMethod,
      userId: ids.aiAdmin,
    })),
    serverDB: db,
  } as never);

const successTokens = {
  status: 'success' as const,
  tokens: {
    accessToken: ACCESS_TOKEN,
    accountId: ACCOUNT_ID,
    expiresIn: 3600,
    refreshToken: REFRESH_TOKEN,
    tokenType: 'bearer',
  },
};

describe('admin.aiProviderOAuth.initiateDeviceCode', () => {
  it('rejects providers that do not issue a rotating refresh token', async () => {
    const caller = await callerFor();

    // GitHub Copilot has a device flow but exchanges a stable token — not a shared account.
    await expect(
      caller.aiProviderOAuth.initiateDeviceCode({ id: 'githubcopilot' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(caller.aiProviderOAuth.initiateDeviceCode({ id: 'openai' })).rejects.toMatchObject(
      { code: 'PRECONDITION_FAILED' },
    );

    expect(oauthService.initiateDeviceCode).not.toHaveBeenCalled();
    expect(await db.select().from(platformAuditLogs)).toEqual([]);
  });

  it('returns the device code and audits the attempt', async () => {
    oauthService.initiateDeviceCode.mockResolvedValue({
      deviceCode: 'device-code-1',
      expiresIn: 900,
      interval: 8,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.com/device',
    });

    const result = await (await callerFor()).aiProviderOAuth.initiateDeviceCode({ id: 'chatgpt' });

    expect(result).toEqual({
      deviceCode: 'device-code-1',
      expiresIn: 900,
      interval: 8,
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.com/device',
      verificationUriComplete: null,
    });
    expect(await db.select().from(platformAuditLogs)).toMatchObject([
      {
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ids.aiAdmin,
        result: 'success',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
  });
});

describe('admin.aiProviderOAuth.pollAuthStatus', () => {
  it('does not write anything while the authorization is still pending', async () => {
    const applyImmediate = vi.fn();
    serviceSeam.applyProviderImmediate = applyImmediate;
    oauthService.pollForToken.mockResolvedValue({ status: 'pending' });

    const result = await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });

    expect(result).toEqual({
      published: false,
      publishError: null,
      revision: null,
      status: 'pending',
      stored: false,
    });
    expect(applyImmediate).not.toHaveBeenCalled();
    expect(await db.select().from(platformAiProviders)).toEqual([]);
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    expect(await db.select().from(platformAuditLogs)).toEqual([]);
  });

  it('stores the authorized connection through the catalog admin service', async () => {
    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: null,
      published: true,
      publishError: null,
      revision: 3,
    });
    serviceSeam.applyProviderImmediate = applyImmediate;
    oauthService.pollForToken.mockResolvedValue(successTokens);

    const result = await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });

    expect(result).toEqual({
      published: true,
      publishError: null,
      revision: 3,
      status: 'success',
      stored: true,
    });
    expect(applyImmediate).toHaveBeenCalledWith(ids.aiAdmin, {
      description: expect.anything(),
      displayName: expect.any(String),
      mode: 'create',
      providerKey: 'chatgpt',
      reason: 'connect shared chatgpt account',
      secret: {
        operation: 'replace',
        value: {
          oauthAccessToken: ACCESS_TOKEN,
          oauthAccountId: ACCOUNT_ID,
          oauthRefreshToken: REFRESH_TOKEN,
          oauthTokenExpiresAt: expect.stringMatching(/^\d+$/),
        },
      },
      settings: expect.any(Object),
      source: 'builtin',
    });
  });

  it('omits the account id for providers whose credential shape rejects it', async () => {
    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: null,
      published: true,
      publishError: null,
      revision: 1,
    });
    serviceSeam.applyProviderImmediate = applyImmediate;
    oauthService.pollForToken.mockResolvedValue(successTokens);

    await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'supergrok',
      reason: 'connect shared supergrok account',
    });

    expect(applyImmediate.mock.calls[0]?.[1]).toMatchObject({
      secret: {
        operation: 'replace',
        value: {
          oauthAccessToken: ACCESS_TOKEN,
          oauthRefreshToken: REFRESH_TOKEN,
        },
      },
    });
    expect(applyImmediate.mock.calls[0]?.[1]).not.toHaveProperty('secret.value.oauthAccountId');
  });

  it('denies the store without a recent interactive authentication and writes no secret', async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await callerFor({ authenticatedAt: null, authMethod: 'better-auth' });

    await expect(
      caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: 'device-code-1',
        id: 'chatgpt',
        reason: `denied ${ACCESS_TOKEN}`,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toMatchObject([
      {
        action: 'admin.aiProviderOAuth.pollAuthStatus',
        afterDiff: { error: 'reauth_required' },
        result: 'denied',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(ACCESS_TOKEN);
  });
});

describe('admin.aiProviderOAuth.getConnectionStatus', () => {
  it('reports a presence-only status without any token material', async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await callerFor();
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' });

    expect(status).toEqual({
      accountIdMasked: 'acct…',
      connected: true,
      expiresAt: expect.stringMatching(/^\d+$/),
      secretConfigured: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCOUNT_ID);
  });

  it('reports a disconnected status when the platform row does not exist', async () => {
    const status = await (
      await callerFor()
    ).aiProviderOAuth.getConnectionStatus({
      id: 'supergrok',
    });

    expect(status).toEqual({
      accountIdMasked: null,
      connected: false,
      expiresAt: null,
      secretConfigured: false,
    });
  });
});
