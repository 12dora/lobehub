// @vitest-environment node
/**
 * admin.aiProviderOAuth — shared platform device-flow connection.
 * Covers provider admission, the reauth gate on both steps (asserted before the
 * single-use grant is redeemed), the pending/no-write path, the create and reconnect
 * store branches with their audits, sanitized failure audits, and the presence-only
 * projection of the status query.
 */
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
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

import { ChatGPTWebOAuthService } from '../../services/chatgptWeb/oauthService';
import { deletePlatformAuditLogsForTest } from '../../testing/deletePlatformAuditLogs';
import { deletePlatformResourceRevisionsForTest } from '../../testing/deletePlatformResourceRevisions';
import { adminRouter } from '../admin';
import type * as AiCatalogSupport from './aiCatalogSupport';

const oauthService = vi.hoisted(() => ({
  initiateDeviceCode: vi.fn(),
  pollForToken: vi.fn(),
}));

/**
 * The paste flow is gated on a REAL `ChatGPTWebOAuthService` instance (the router refuses
 * to run it against anything else), so `chatgptweb` gets the real service with only its
 * two network seams mocked — the envelope, PKCE, state binding and vault projection are
 * all exercised for real.
 */
const chatgptWeb = vi.hoisted(() => ({
  authFetch: vi.fn(),
  service: null as unknown,
  transportFetch: vi.fn(),
}));

vi.mock('@/server/services/oauthDeviceFlow/providers/githubCopilot', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOAuthService: vi.fn((providerId: string) =>
    providerId === 'chatgptweb' ? chatgptWeb.service : oauthService,
  ),
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
const ids = {
  aiAdmin: 'oauth-shared-ai-admin',
  /** UPDATE + PUBLISH but no CREATE — the exact set disconnect is supposed to accept. */
  withdrawer: 'oauth-shared-withdrawer',
  /**
   * Exactly the three permissions this router requires — and NOT AI_MODEL_CREATE. Proves the
   * builtin default-model seeding on first connect rides the provider-create grant instead of
   * locking an otherwise-authorized operator out of the whole flow.
   */
  providerOnly: 'oauth-shared-provider-only',
  /** UPDATE only — publishing the withdrawal is part of the operation, so this must fail. */
  updateOnly: 'oauth-shared-update-only',
};

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

/** Grant exactly one ad-hoc global role carrying the given permission codes. */
const grantPermissions = async (userId: string, roleName: string, codes: string[]) => {
  const [role] = await db
    .insert(roles)
    .values({ displayName: roleName, name: roleName })
    .returning();
  const granted = await db
    .select({ code: permissions.code, id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, codes));
  await db
    .insert(rolePermissions)
    .values(granted.map(({ id }) => ({ permissionId: id, roleId: role.id })));
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 41).toString('base64'));
  oauthService.initiateDeviceCode.mockReset();
  oauthService.pollForToken.mockReset();
  chatgptWeb.authFetch.mockReset();
  chatgptWeb.transportFetch.mockReset();
  chatgptWeb.service = new ChatGPTWebOAuthService({
    authFetch: chatgptWeb.authFetch as unknown as typeof fetch,
    transportFetch: chatgptWeb.transportFetch as unknown as typeof fetch,
  });
  serviceSeam.applyProviderImmediate = null;
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await assignGlobalPlatformRole(db, {
    roleName: PLATFORM_SYSTEM_ROLES.AI_ADMIN,
    userId: ids.aiAdmin,
  });
  await grantPermissions(ids.withdrawer, 'oauth-shared-withdrawer-role', [
    PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
  ]);
  await grantPermissions(ids.updateOnly, 'oauth-shared-update-only-role', [
    PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
  ]);
  await grantPermissions(ids.providerOnly, 'oauth-shared-provider-only-role', [
    PLATFORM_PERMISSIONS.AI_PROVIDER_CREATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_UPDATE,
    PLATFORM_PERMISSIONS.AI_PROVIDER_PUBLISH,
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (
  auth: {
    authenticatedAt: Date | null;
    authMethod: 'api-key' | 'better-auth';
    userId?: string;
  } = {
    authenticatedAt: new Date(),
    authMethod: 'better-auth',
  },
) =>
  createCaller({
    ...(await createContextInner({
      authenticatedAt: auth.authenticatedAt,
      authMethod: auth.authMethod,
      userId: auth.userId ?? ids.aiAdmin,
    })),
    serverDB: db,
  } as never);

const ACCOUNT_EMAIL = 'operator@example.test';

const successTokens = {
  status: 'success' as const,
  tokens: {
    accessToken: ACCESS_TOKEN,
    accountId: ACCOUNT_ID,
    email: ACCOUNT_EMAIL,
    expiresIn: 3600,
    refreshToken: REFRESH_TOKEN,
    tokenType: 'bearer',
  },
};

/** Stale-session caller: the reauth gate must deny before anything is redeemed. */
const staleCaller = () => callerFor({ authenticatedAt: null, authMethod: 'better-auth' });

const auditRowsFor = async (action: string) =>
  (await db.select().from(platformAuditLogs)).filter((row) => row.action === action);

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
      // Device-code providers never offer the access-token paste fallback.
      allowAccessTokenPaste: false,
      deviceCode: 'device-code-1',
      expiresIn: 900,
      flow: 'device_code',
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

  /**
   * The device grant issued here is single-use, so the freshness window has to be taken on
   * this click-driven call — a stale session must never reach the authorization server.
   */
  it('requires a recent interactive authentication before contacting the provider', async () => {
    const caller = await staleCaller();

    await expect(
      caller.aiProviderOAuth.initiateDeviceCode({ id: 'chatgpt' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(oauthService.initiateDeviceCode).not.toHaveBeenCalled();
    expect(await db.select().from(platformAuditLogs)).toMatchObject([
      {
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ids.aiAdmin,
        afterDiff: { error: 'reauth_required' },
        result: 'denied',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
  });

  it('audits a failed device code request without echoing provider prose', async () => {
    const prose = 'authorization server said: client_id 0oa-secret-value is not permitted';
    oauthService.initiateDeviceCode.mockRejectedValue(new Error(prose));

    await expect(
      (await callerFor()).aiProviderOAuth.initiateDeviceCode({ id: 'supergrok' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    const audits = await db.select().from(platformAuditLogs);
    expect(audits).toMatchObject([
      {
        action: 'admin.aiProviderOAuth.initiateDeviceCode',
        actorUserId: ids.aiAdmin,
        afterDiff: { error: 'device_code_request_failed', providerKey: 'supergrok' },
        result: 'failure',
        targetId: 'supergrok',
        targetType: 'provider',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(prose);
    expect(JSON.stringify(audits)).not.toContain('0oa-secret-value');
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

    expect(result).toEqual({ error: null, revision: null, status: 'pending', stored: false });
    expect(applyImmediate).not.toHaveBeenCalled();
    expect(oauthService.pollForToken).toHaveBeenCalledTimes(1);
    expect(await db.select().from(platformAiProviders)).toEqual([]);
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    expect(await db.select().from(platformAuditLogs)).toEqual([]);
  });

  it('stores the authorized connection through the catalog admin service', async () => {
    // Storing publishes unconditionally; the provider's `enabled` state is left untouched.
    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: 'apply-audit-id',
      draft: { id: 'created-provider-row-id' },
      revision: 1,
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

    expect(result).toEqual({ error: null, revision: 1, status: 'success', stored: true });
    expect(await auditRowsFor('admin.aiProviderOAuth.pollAuthStatus')).toMatchObject([
      {
        actorUserId: ids.aiAdmin,
        afterDiff: { mode: 'create', providerKey: 'chatgpt', revision: 1 },
        result: 'success',
        targetId: 'created-provider-row-id',
        targetType: 'provider',
      },
    ]);
    expect(applyImmediate).toHaveBeenCalledWith(ids.aiAdmin, {
      // Seeded from the builtin card so the admin connectivity probe can run on first connect.
      checkModel: expect.any(String),
      description: expect.anything(),
      displayName: expect.any(String),
      // First connect activates the shared account — otherwise the row would be invisible
      // to runtime while the panel reports a live connection.
      enabled: true,
      mode: 'create',
      providerKey: 'chatgpt',
      reason: 'connect shared chatgpt account',
      secret: {
        operation: 'replace',
        value: {
          oauthAccessToken: ACCESS_TOKEN,
          oauthAccountEmail: ACCOUNT_EMAIL,
          oauthAccountId: ACCOUNT_ID,
          // Connect time is the keepalive anchor of a grant that has never been refreshed.
          oauthLastRefreshAt: expect.stringMatching(/^\d+$/),
          oauthRefreshToken: REFRESH_TOKEN,
          oauthTokenExpiresAt: expect.stringMatching(/^\d+$/),
        },
      },
      settings: expect.any(Object),
      source: 'builtin',
    });
  });

  /**
   * The refresh pipeline measures the 3-day forced keepalive from `oauthLastRefreshAt` and
   * the 5-minute quiet period from `oauthLastRefreshErrorAt`. A connect that stamped
   * neither would leave the shared grant with no anchor at all, and a RECONNECT that kept a
   * previous error stamp would sit out the first five minutes of its new life.
   */
  it('stamps the keepalive anchor and clears the refresh backoff on connect', async () => {
    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: 'apply-audit-id',
      draft: { id: 'created-provider-row-id' },
      revision: 1,
    });
    serviceSeam.applyProviderImmediate = applyImmediate;
    oauthService.pollForToken.mockResolvedValue(successTokens);

    const before = Date.now();
    await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    const after = Date.now();

    const secret = applyImmediate.mock.calls[0]?.[1]?.secret;
    const stamped = Number(secret.value.oauthLastRefreshAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    // `replace` drops everything the new credential did not provide, so the error stamp is
    // gone by construction — it must never be written as a value either.
    expect(secret.value).not.toHaveProperty('oauthLastRefreshErrorAt');
  });

  it('omits the account id for providers whose credential shape rejects it', async () => {
    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: 'apply-audit-id',
      draft: { id: 'created-provider-row-id' },
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

  /**
   * The freshness check has to run BEFORE the token exchange: the device grant is
   * single-use, so a tick that cannot store the result must not redeem it (the operator
   * would be left with a burnt authorization and a dead-ended flow).
   */
  it('denies a stale session before the device grant is redeemed', async () => {
    const applyImmediate = vi.fn();
    serviceSeam.applyProviderImmediate = applyImmediate;
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await staleCaller();

    await expect(
      caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: 'device-code-1',
        id: 'chatgpt',
        reason: 'connect shared chatgpt account',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(oauthService.pollForToken).not.toHaveBeenCalled();
    expect(applyImmediate).not.toHaveBeenCalled();
    expect(await db.select().from(platformAiProviderSecrets)).toEqual([]);
    expect(await db.select().from(platformAuditLogs)).toMatchObject([
      {
        action: 'admin.aiProviderOAuth.pollAuthStatus',
        afterDiff: { error: 'reauth_required' },
        result: 'denied',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
  });

  it('keeps the stored token out of the denial audit reason on a reconnect', async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    oauthService.pollForToken.mockClear();

    const caller = await staleCaller();
    await expect(
      caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: 'device-code-2',
        id: 'chatgpt',
        reason: `reconnect ${ACCESS_TOKEN}`,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(oauthService.pollForToken).not.toHaveBeenCalled();
    const denied = (await auditRowsFor('admin.aiProviderOAuth.pollAuthStatus')).filter(
      (row) => row.result === 'denied',
    );
    expect(denied).toHaveLength(1);
    expect(JSON.stringify(denied)).not.toContain(ACCESS_TOKEN);
  });

  it('first connect creates an enabled, published provider row', async () => {
    // Connecting a shared account is the activation intent: an enabled:false row would be
    // invisible to runtime while the panel reports a live connection.
    oauthService.pollForToken.mockResolvedValue(successTokens);

    const result = await (
      await callerFor()
    ).aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });

    expect(result).toMatchObject({ status: 'success', stored: true });
    expect(result.revision).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(platformAiProviders);
    expect(row).toMatchObject({
      enabled: true,
      providerKey: 'chatgpt',
      source: 'builtin',
      status: 'published',
    });
    expect(row.revision).toBeGreaterThanOrEqual(1);
  });

  it('reconnects an existing shared account through the update branch', async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await callerFor();
    // Unmocked service: pins the real create-branch contract the mocked tests above assert.
    const created = await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    // Unmocked create branch: the store published the shared connection immediately.
    expect(created).toEqual({ error: null, revision: 1, status: 'success', stored: true });

    // Concurrency expectations are read back independently of the router under test.
    const stored = await caller.aiProviders.get({ providerKey: 'chatgpt' });
    expect(stored.draftToken).toHaveLength(64);

    const applyImmediate = vi.fn().mockResolvedValue({
      auditId: 'apply-audit-id',
      draft: { id: stored.draft.id },
      revision: 2,
    });
    serviceSeam.applyProviderImmediate = applyImmediate;

    const result = await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-2',
      id: 'chatgpt',
      reason: 'reconnect shared chatgpt account',
    });

    expect(result).toEqual({ error: null, revision: 2, status: 'success', stored: true });
    // Merge (not replace): a reconnect must not drop vault leaves this flow does not set.
    expect(applyImmediate).toHaveBeenCalledWith(ids.aiAdmin, {
      expectedDraftToken: stored.draftToken,
      expectedRevision: stored.baseRevision,
      id: stored.draft.id,
      mode: 'update',
      reason: 'reconnect shared chatgpt account',
      secret: {
        operation: 'merge',
        // A reconnect must not inherit the previous grant's refresh backoff, so the error
        // stamp is explicitly unset rather than left behind by the merge.
        unset: ['oauthLastRefreshErrorAt'],
        value: {
          oauthAccessToken: ACCESS_TOKEN,
          oauthAccountEmail: ACCOUNT_EMAIL,
          oauthAccountId: ACCOUNT_ID,
          oauthLastRefreshAt: expect.stringMatching(/^\d+$/),
          oauthRefreshToken: REFRESH_TOKEN,
          oauthTokenExpiresAt: expect.stringMatching(/^\d+$/),
        },
      },
    });
    // A reconnect must never resurrect a provider an admin turned off on purpose — and it
    // is the disconnect procedure, not this one, that is allowed to write `enabled`.
    expect(applyImmediate.mock.calls[0]?.[1]).not.toHaveProperty('enabled');
    expect(
      (await auditRowsFor('admin.aiProviderOAuth.pollAuthStatus')).filter(
        (row) => row.result === 'success',
      ),
    ).toMatchObject([
      { afterDiff: { mode: 'create' } },
      { afterDiff: { mode: 'update' }, targetId: stored.draft.id },
    ]);
  });

  it('reports a terminal denied outcome when the store fails after the grant is redeemed', async () => {
    // The device grant is single-use: a throw here would strand the operator mid-poll.
    const applyImmediate = vi
      .fn()
      .mockRejectedValue(new Error('sensitive apply prose sk-should-never-surface'));
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
      error: 'provider_store_failed',
      revision: null,
      status: 'denied',
      stored: false,
    });
    const audits = await auditRowsFor('admin.aiProviderOAuth.pollAuthStatus');
    expect(audits).toMatchObject([
      {
        afterDiff: { error: 'provider_store_failed', mode: 'create', providerKey: 'chatgpt' },
        result: 'failure',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain('sk-should-never-surface');
  });

  it('maps a failed token exchange to a stable error and audits it without provider prose', async () => {
    const prose = 'token endpoint rejected device_code dev-secret-material';
    oauthService.pollForToken.mockRejectedValue(new Error(prose));
    const applyImmediate = vi.fn();
    serviceSeam.applyProviderImmediate = applyImmediate;

    await expect(
      (await callerFor()).aiProviderOAuth.pollAuthStatus({
        deviceCode: 'device-code-1',
        id: 'chatgpt',
        reason: 'connect shared chatgpt account',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(applyImmediate).not.toHaveBeenCalled();
    const audits = await auditRowsFor('admin.aiProviderOAuth.pollAuthStatus');
    expect(audits).toMatchObject([
      {
        actorUserId: ids.aiAdmin,
        afterDiff: { error: 'device_token_exchange_failed', providerKey: 'chatgpt' },
        result: 'failure',
        targetId: 'chatgpt',
        targetType: 'provider',
      },
    ]);
    expect(JSON.stringify(audits)).not.toContain(prose);
    expect(JSON.stringify(audits)).not.toContain('dev-secret-material');
  });
});

describe('admin.aiProviderOAuth.disconnect', () => {
  const DISCONNECT_REASON = 'withdraw the shared account';

  /** Connect for real (unmocked service) so the disconnect has durable state to remove. */
  const connect = async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await callerFor();
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    return caller;
  };

  it('rejects providers that cannot hold a shared rotating-refresh account', async () => {
    const caller = await callerFor();

    await expect(
      caller.aiProviderOAuth.disconnect({ id: 'openai', reason: DISCONNECT_REASON }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.aiProviderOAuth.disconnect({ id: 'githubcopilot', reason: DISCONNECT_REASON }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // Admission runs before anything is audited: an unsupported key leaves no trail.
    expect(await db.select().from(platformAuditLogs)).toEqual([]);
  });

  it('is a no-op when no shared account was ever stored', async () => {
    const applyImmediate = vi.fn();
    serviceSeam.applyProviderImmediate = applyImmediate;

    const result = await (
      await callerFor()
    ).aiProviderOAuth.disconnect({ id: 'supergrok', reason: DISCONNECT_REASON });

    expect(result).toEqual({ disconnected: false, revision: null });
    expect(applyImmediate).not.toHaveBeenCalled();
    // No write happened, so there is no outcome to audit.
    expect(await auditRowsFor('admin.aiProviderOAuth.disconnect')).toEqual([]);
  });

  it('clears the whole shared vault and turns the provider off', async () => {
    const caller = await connect();
    const [connected] = await db.select().from(platformAiProviders);
    expect(connected).toMatchObject({ enabled: true, providerKey: 'chatgpt' });

    const result = await caller.aiProviderOAuth.disconnect({
      id: 'chatgpt',
      reason: DISCONNECT_REASON,
    });

    expect(result.disconnected).toBe(true);
    expect(result.revision).toBeGreaterThan(connected.revision);

    const [row] = await db.select().from(platformAiProviders);
    expect(row).toMatchObject({
      // An enabled provider with an empty vault is a site-wide outage members cannot
      // escape; disabled hands them back to their own BYOK config instead.
      enabled: false,
      providerKey: 'chatgpt',
      // `clear` unlinks the ciphertext entirely — the account email goes with it.
      encryptedKeyVaults: null,
      secretFingerprint: null,
      status: 'published',
    });

    // The status query must answer cleanly on an empty vault rather than throwing.
    expect(await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' })).toEqual({
      accountEmail: null,
      accountIdMasked: null,
      canRefresh: false,
      connected: false,
      expired: false,
      expiresAt: null,
      flow: 'device_code',
      renewalKind: null,
      secretConfigured: false,
    });
  });

  it('audits the withdrawal with stable codes only', async () => {
    const caller = await connect();

    const result = await caller.aiProviderOAuth.disconnect({
      id: 'chatgpt',
      reason: DISCONNECT_REASON,
    });

    const audits = await auditRowsFor('admin.aiProviderOAuth.disconnect');
    expect(audits).toMatchObject([
      {
        actorUserId: ids.aiAdmin,
        afterDiff: { enabled: false, providerKey: 'chatgpt', revision: result.revision },
        result: 'success',
        targetType: 'provider',
      },
    ]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    // The account identity is projected to the panel, but it is never audit material.
    expect(serialized).not.toContain(ACCOUNT_EMAIL);
  });

  it('denies a stale session and writes nothing', async () => {
    await connect();
    const [before] = await db.select().from(platformAiProviders);
    const stale = await staleCaller();

    await expect(
      stale.aiProviderOAuth.disconnect({
        id: 'chatgpt',
        // The stored token must not survive into the denial audit reason.
        reason: `disconnect ${ACCESS_TOKEN}`,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const [after] = await db.select().from(platformAiProviders);
    expect(after).toMatchObject({ enabled: true, revision: before.revision });
    expect(after.encryptedKeyVaults).toBe(before.encryptedKeyVaults);

    const denied = await auditRowsFor('admin.aiProviderOAuth.disconnect');
    expect(denied).toMatchObject([
      { afterDiff: { error: 'reauth_required' }, result: 'denied', targetType: 'provider' },
    ]);
    expect(JSON.stringify(denied)).not.toContain(ACCESS_TOKEN);
  });

  it('is idempotent: withdrawing an already-empty vault still succeeds', async () => {
    const caller = await connect();
    await caller.aiProviderOAuth.disconnect({ id: 'chatgpt', reason: DISCONNECT_REASON });

    const again = await caller.aiProviderOAuth.disconnect({
      id: 'chatgpt',
      reason: DISCONNECT_REASON,
    });

    expect(again.disconnected).toBe(true);
    const [row] = await db.select().from(platformAiProviders);
    expect(row).toMatchObject({ enabled: false, encryptedKeyVaults: null });
  });

  /**
   * The shared-refresh lease is deliberately NOT cancelled on disconnect (it self-expires,
   * and a holder that started before the clear still owns it). That holder can finish by
   * CAS-rewriting the secret VERSION row it consumed — `clear` only unlinks that row from
   * the provider. This pins the consequence: presence is read from the provider row, so a
   * late rotation cannot bring the connection back.
   */
  it('cannot be resurrected by a rotation that was already holding the refresh lease', async () => {
    const caller = await connect();
    const [version] = await db.select().from(platformAiProviderSecrets);
    expect(version).toBeTruthy();

    await caller.aiProviderOAuth.disconnect({ id: 'chatgpt', reason: DISCONNECT_REASON });

    // Stand in for the late CAS persist of an in-flight refresh. The rewritten content is
    // irrelevant precisely because nothing on the live path reads this row any more.
    await db
      .update(platformAiProviderSecrets)
      .set({ ciphertext: version.ciphertext })
      .where(eq(platformAiProviderSecrets.id, version.id));

    expect(await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' })).toMatchObject({
      connected: false,
      secretConfigured: false,
    });
    const [row] = await db.select().from(platformAiProviders);
    expect(row).toMatchObject({
      enabled: false,
      encryptedKeyVaults: null,
      secretFingerprint: null,
    });
  });

  it('accepts UPDATE + PUBLISH without requiring CREATE, and rejects UPDATE alone', async () => {
    await connect();

    // Withdrawal only ever updates an existing row: gating it behind CREATE would leave an
    // operator unable to stop a live shared credential.
    const withdrawer = await callerFor({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: ids.withdrawer,
    });
    const result = await withdrawer.aiProviderOAuth.disconnect({
      id: 'chatgpt',
      reason: DISCONNECT_REASON,
    });
    expect(result.disconnected).toBe(true);

    // Publishing is part of the operation — UPDATE alone cannot make the change live.
    const updateOnly = await callerFor({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: ids.updateOnly,
    });
    await expect(
      updateOnly.aiProviderOAuth.disconnect({ id: 'chatgpt', reason: DISCONNECT_REASON }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('admin.aiProviderOAuth.getConnectionStatus', () => {
  it('rejects providers that cannot hold a shared rotating-refresh account', async () => {
    const caller = await callerFor();

    await expect(
      caller.aiProviderOAuth.getConnectionStatus({ id: 'openai' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      caller.aiProviderOAuth.getConnectionStatus({ id: 'githubcopilot' }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

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
      // The admin's own shared account is named in full; the Codex workspace UUID stays masked.
      accountEmail: ACCOUNT_EMAIL,
      accountIdMasked: 'acct…',
      canRefresh: true,
      connected: true,
      expired: false,
      expiresAt: expect.stringMatching(/^\d+$/),
      flow: 'device_code',
      // Epoch millis as a string, exactly like `expiresAt` — both mirror the vault leaf.
      lastRefreshAt: expect.stringMatching(/^\d+$/),
      // A device-code grant stores no kind label, so the credential's shape decides — and
      // an opaque refresh token is the OAuth one it can only be.
      renewalKind: 'oauth',
      secretConfigured: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCOUNT_ID);
  });

  /**
   * The panel has to be able to distinguish a connection that is quietly renewing itself
   * from one nothing has touched since it was made — which is exactly the state that ends
   * with a silently dropped refresh token upstream.
   */
  it('projects the refresh anchor stamped at connect', async () => {
    oauthService.pollForToken.mockResolvedValue(successTokens);
    const caller = await callerFor();

    const before = Date.now();
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    const after = Date.now();

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' });
    expect(status.lastRefreshAt).toMatch(/^\d+$/);
    const stamped = Number(status.lastRefreshAt);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it('replaces the account email on reconnect, and clears it when the new token has none', async () => {
    const caller = await callerFor();
    oauthService.pollForToken.mockResolvedValue(successTokens);
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });
    expect((await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' })).accountEmail).toBe(
      ACCOUNT_EMAIL,
    );

    // Reconnect as a different account: the identity must follow the new credential.
    oauthService.pollForToken.mockResolvedValue({
      ...successTokens,
      tokens: { ...successTokens.tokens, email: 'someone-else@example.test' },
    });
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-2',
      id: 'chatgpt',
      reason: 'reconnect as another account',
    });
    expect((await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' })).accountEmail).toBe(
      'someone-else@example.test',
    );

    // Reconnect with a token carrying NO email claim: a plain merge would strand the previous
    // account's email next to the new credential, so the leaf is explicitly unset.
    oauthService.pollForToken.mockResolvedValue({
      status: 'success' as const,
      tokens: {
        accessToken: 'opaque-access-token-without-claims',
        accountId: ACCOUNT_ID,
        expiresIn: 3600,
        refreshToken: REFRESH_TOKEN,
        tokenType: 'bearer',
      },
    });
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-3',
      id: 'chatgpt',
      reason: 'reconnect without an email claim',
    });

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' });
    expect(status.accountEmail).toBeNull();
    // Falls back to the masked account id rather than showing a stale identity.
    expect(status.accountIdMasked).toBe('acct…');
    const [row] = await db.select().from(platformAiProviders);
    expect(row.encryptedKeyVaults).not.toContain('someone-else@example.test');
  });

  it('recovers the account email from the stored token when the leaf predates the feature', async () => {
    // Connections stored before oauthAccountEmail existed must still name their account:
    // the claim is decoded from the access token we already hold, and never persisted.
    const claims = Buffer.from(
      JSON.stringify({ chatgpt_account_id: ACCOUNT_ID, email: 'legacy@example.test' }),
      'utf8',
    ).toString('base64url');
    const legacyJwt = `eyJhbGciOiJub25lIn0.${claims}.sig`;
    oauthService.pollForToken.mockResolvedValue({
      status: 'success' as const,
      tokens: {
        accessToken: legacyJwt,
        accountId: ACCOUNT_ID,
        expiresIn: 3600,
        refreshToken: REFRESH_TOKEN,
        tokenType: 'bearer',
      },
    });
    const caller = await callerFor();
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'chatgpt',
      reason: 'connect shared chatgpt account',
    });

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgpt' });
    expect(status.accountEmail).toBe('legacy@example.test');
    // Read-time only: nothing was written back into the vault.
    const [row] = await db.select().from(platformAiProviders);
    expect(row.encryptedKeyVaults).not.toContain('legacy@example.test');
  });

  it('reports a disconnected status when the platform row does not exist', async () => {
    const status = await (
      await callerFor()
    ).aiProviderOAuth.getConnectionStatus({
      id: 'supergrok',
    });

    expect(status).toEqual({
      accountEmail: null,
      accountIdMasked: null,
      canRefresh: false,
      connected: false,
      expired: false,
      expiresAt: null,
      flow: 'device_code',
      renewalKind: null,
      secretConfigured: false,
    });
  });

  /**
   * SuperGrok's credential shape has no `oauthAccountEmail` leaf: it deliberately does not
   * surface an account identity. Decoding a standard `email` claim out of its access token
   * would publish exactly what the shape withholds, to every admin with AI_PROVIDER_READ.
   */
  it('never projects an email for a provider whose credential shape has no email leaf', async () => {
    const claims = Buffer.from(
      JSON.stringify({ email: 'grok-owner@example.test' }),
      'utf8',
    ).toString('base64url');
    oauthService.pollForToken.mockResolvedValue({
      status: 'success' as const,
      tokens: {
        accessToken: `eyJhbGciOiJub25lIn0.${claims}.sig`,
        expiresIn: 3600,
        refreshToken: REFRESH_TOKEN,
        tokenType: 'bearer',
      },
    });
    const caller = await callerFor();
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: 'device-code-1',
      id: 'supergrok',
      reason: 'connect shared supergrok account',
    });

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'supergrok' });

    expect(status).toMatchObject({ accountEmail: null, canRefresh: true, connected: true });
    expect(JSON.stringify(status)).not.toContain('grok-owner@example.test');
  });
});

/**
 * `chatgptweb` runs the authorization-code PASTE flow: the operator signs in in their own
 * browser and pastes the callback back, and there is an access-token fallback with no
 * refresh grant at all. These run against the real service (network seams mocked only).
 */
describe('admin.aiProviderOAuth paste flow (chatgptweb)', () => {
  const jwt = (claims: Record<string, unknown>): string =>
    [
      Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify(claims)).toString('base64url'),
      'sig',
    ].join('.');

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json' },
      status,
    });

  const futureExp = Math.floor(Date.now() / 1000) + 86_400;
  const PASTE_ACCESS_TOKEN = jwt({
    'exp': futureExp,
    'https://api.openai.com/auth': { chatgpt_account_id: 'acct-web-1' },
  });

  /** Real initiate: the returned deviceCode is the client-held PKCE/state envelope. */
  const startFlow = async (caller: Awaited<ReturnType<typeof callerFor>>) => {
    const started = await caller.aiProviderOAuth.initiateDeviceCode({ id: 'chatgptweb' });
    const envelope = JSON.parse(started.deviceCode) as { deviceId: string; state: string };
    return { envelope, started };
  };

  /** next-auth compact JWE: `dir` header, empty encrypted-key segment. */
  const sessionJwe = [
    Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
    '',
    'aXY',
    'Y3Q',
    'dGFn',
  ].join('.');

  /** The chatgpt.com endpoints a web-session connect touches, in one seam. */
  const mockSessionBackend = (body: unknown, email = 'session@example.test') => {
    chatgptWeb.transportFetch.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/api/auth/session')) return jsonResponse(body);
      if (String(url).endsWith('/backend-api/me')) return jsonResponse({ email });
      return jsonResponse({ accounts: { default: { account: { id: 'acct-web-3' } } } });
    });
  };

  it('starts the connect flow with an envelope and a pasted-credential route', async () => {
    const caller = await callerFor();
    const { started } = await startFlow(caller);

    expect(started).toMatchObject({
      allowAccessTokenPaste: true,
      flow: 'authorization_code_paste',
      interval: 0,
      userCode: '',
    });
    // Still minted: the envelope carries the device id the session path presents as
    // `oai-device-id`, so initiate stays the entry point of BOTH pasted-credential routes.
    expect(started.verificationUri).toContain('https://auth.openai.com/api/accounts/authorize');
  });

  /**
   * The authorization page of this provider asks for the platform API audience and lands on
   * platform.openai.com — a different product from the chatgpt.com subscription the runtime
   * talks to, so a grant redeemed there can be stored and still fail every conversation. The
   * card declares `webSessionOnly` and the router refuses the exchange, including for an
   * older client that still offers the button.
   */
  it.each([
    ['a pasted callback URL', 'https://platform.openai.com/auth/callback?code=the-code&state=s'],
    ['a bare authorization code', 'the-code'],
  ])('refuses %s for a web-session-only provider', async (_label, callbackUrl) => {
    const caller = await callerFor();
    const { started } = await startFlow(caller);

    await expect(
      caller.aiProviderOAuth.pollAuthStatus({
        callbackUrl,
        deviceCode: started.deviceCode,
        id: 'chatgptweb',
        reason: 'connect the shared ChatGPT Web account',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // Refused before any exchange: the code is never spent and nothing is stored.
    expect(chatgptWeb.authFetch).not.toHaveBeenCalled();
    expect(await db.select().from(platformAiProviders)).toEqual([]);
    // A pasted callback carries a live authorization code — never audited, never logged.
    expect(JSON.stringify(await db.select().from(platformAuditLogs))).not.toContain('the-code');
  });

  it('returns pending without any network work until something is pasted', async () => {
    const caller = await callerFor();
    const { started } = await startFlow(caller);

    const result = await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: started.deviceCode,
      id: 'chatgptweb',
      reason: 'poll the shared ChatGPT Web connection',
    });

    expect(result).toEqual({ error: null, revision: null, status: 'pending', stored: false });
    expect(chatgptWeb.authFetch).not.toHaveBeenCalled();
    expect(chatgptWeb.transportFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed envelope', 'not-json', 'invalid_callback'],
    [
      // Every field is the shape `initiateDeviceCode` mints (uuid v4 device id, base64url
      // verifier, dotted state) — only the age is wrong, so `expired` is the outcome.
      'a stale envelope',
      JSON.stringify({
        createdAt: Date.now() - 11 * 60 * 1000,
        deviceId: '3f7c0f7a-6f6e-4a1b-9c2d-8e5a1b2c3d4e',
        state: `${'a1b2c3d4'.repeat(4)}.Zm9vYmFy_-abc`,
        v: 1,
        verifier: 'v'.repeat(86),
      }),
      'expired',
    ],
    [
      // Shape-only validation accepted this: the empty device id was then persisted and
      // sent as `oai-device-id` on every later request.
      'an envelope with empty fields',
      JSON.stringify({ createdAt: Date.now(), deviceId: '', state: '', v: 1, verifier: '' }),
      'invalid_callback',
    ],
  ])('rejects an access-token paste carrying %s', async (_label, deviceCode, expected) => {
    const caller = await callerFor();

    const result = await caller.aiProviderOAuth.pollAuthStatus({
      accessToken: PASTE_ACCESS_TOKEN,
      deviceCode,
      id: 'chatgptweb',
      reason: 'connect the shared ChatGPT Web account',
    });

    // Minting a fresh device id here would break the sentinel handshake the stored
    // `oai-device-id` is supposed to keep stable.
    expect(result).toMatchObject({ error: expected, status: 'error', stored: false });
    expect(chatgptWeb.transportFetch).not.toHaveBeenCalled();
  });

  /**
   * The finding this locks down: an OAuth connection reconnected with a pasted access
   * token kept the PREVIOUS account's refresh token. The card would keep claiming the
   * connection auto-renews, and at expiry the shared refresh would redeem the old grant
   * and overwrite the new connection with a different account's credentials.
   */
  it('drops the previous renewal credential when reconnecting with a pasted access token', async () => {
    const caller = await callerFor();
    const first = await startFlow(caller);
    mockSessionBackend(
      { accessToken: PASTE_ACCESS_TOKEN, user: { email: 'first@example.test' } },
      'first@example.test',
    );
    await caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: first.started.deviceCode,
      id: 'chatgptweb',
      reason: 'connect the shared ChatGPT Web account',
      sessionToken: sessionJwe,
    });
    expect(await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgptweb' })).toMatchObject({
      canRefresh: true,
      renewalKind: 'web_session',
    });

    // Reconnect as a different account, this time by pasting a bare access token.
    const second = await startFlow(caller);
    const pastedToken = jwt({ exp: futureExp });
    chatgptWeb.transportFetch.mockImplementation(async (url: string) =>
      String(url).endsWith('/backend-api/me')
        ? jsonResponse({ email: 'second@example.test' })
        : jsonResponse({ accounts: { default: { account: { id: 'acct-web-2' } } } }),
    );

    const result = await caller.aiProviderOAuth.pollAuthStatus({
      accessToken: pastedToken,
      deviceCode: second.started.deviceCode,
      id: 'chatgptweb',
      reason: 'reconnect with a pasted access token',
    });
    expect(result).toMatchObject({ status: 'success', stored: true });

    const status = await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgptweb' });
    expect(status).toMatchObject({
      accountEmail: 'second@example.test',
      canRefresh: false,
      connected: true,
      // The label moves as a unit with the credential it describes: a stale `web_session`
      // here would send the next renewal to chatgpt.com with nothing to spend.
      renewalKind: null,
    });
    const [row] = await db.select().from(platformAiProviders);
    expect(row.encryptedKeyVaults).not.toContain(sessionJwe);
    expect(row.encryptedKeyVaults).not.toContain('first@example.test');
  });

  /**
   * The web-session paste: the credential that makes this provider behave like the web app.
   * It is stored in the SAME leaf an OAuth refresh token occupies, so `canRefresh` — and
   * every renewal mechanism behind it — applies without a second lifecycle.
   */
  describe('web-session paste', () => {
    it('stores the session as a RENEWABLE credential and names the renewal path', async () => {
      const caller = await callerFor();
      const { started } = await startFlow(caller);
      mockSessionBackend({
        accessToken: PASTE_ACCESS_TOKEN,
        expires: '2026-12-01T00:00:00.000Z',
        user: { email: 'session@example.test' },
      });

      const result = await caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: started.deviceCode,
        id: 'chatgptweb',
        reason: 'connect the shared ChatGPT Web account with a web session',
        sessionToken: sessionJwe,
      });

      expect(result).toMatchObject({ error: null, status: 'success', stored: true });
      expect(await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgptweb' })).toMatchObject({
        accountEmail: 'session@example.test',
        // The whole point: a pasted credential that DOES renew.
        canRefresh: true,
        connected: true,
        renewalKind: 'web_session',
      });
      // The session is a secret on the wire and must never reach the audit trail.
      expect(JSON.stringify(await db.select().from(platformAuditLogs))).not.toContain(sessionJwe);
    });

    it('reports a dead session with a stable code and stores nothing', async () => {
      const caller = await callerFor();
      const { started } = await startFlow(caller);
      // The unauthenticated answer: 200 with a warning-only body and no access token.
      mockSessionBackend({ WARNING_BANNER: 'do not paste' });

      const result = await caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: started.deviceCode,
        id: 'chatgptweb',
        reason: 'connect the shared ChatGPT Web account with a web session',
        sessionToken: sessionJwe,
      });

      expect(result).toMatchObject({ error: 'session_invalid', status: 'error', stored: false });
      expect(await db.select().from(platformAiProviders)).toEqual([]);
    });

    /**
     * The pasted session ends up interpolated into a `Cookie:` header on requests this server
     * makes with a SHARED credential, so the contract — not just the service — refuses a value
     * carrying cookie/header delimiters. Rejected by the input schema, before any network call
     * and before the reauth-gated body runs.
     */
    it.each([
      ['a cookie separator', 'jwe; oai-did=attacker'],
      ['an assignment', 'jwe=attacker'],
      ['a CRLF header break', 'jwe\r\nX-Injected: 1'],
      ['a control character', 'jwe\u0001attacker'],
    ])('rejects %s in the pasted session at the contract boundary', async (_label, pasted) => {
      const caller = await callerFor();
      const { started } = await startFlow(caller);
      chatgptWeb.transportFetch.mockReset();

      await expect(
        caller.aiProviderOAuth.pollAuthStatus({
          deviceCode: started.deviceCode,
          id: 'chatgptweb',
          reason: 'connect the shared ChatGPT Web account with a web session',
          sessionToken: pasted,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(chatgptWeb.transportFetch).not.toHaveBeenCalled();
    });

    it('replaces the stored session when the same provider is reconnected', async () => {
      const caller = await callerFor();
      const first = await startFlow(caller);
      mockSessionBackend({ accessToken: PASTE_ACCESS_TOKEN, user: { email: 's@example.test' } });
      await caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: first.started.deviceCode,
        id: 'chatgptweb',
        reason: 'connect with a web session',
        sessionToken: sessionJwe,
      });

      const secondJwe = [
        Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM' })).toString('base64url'),
        '',
        'aXY2',
        'Y3Q2',
        'dGFnMg',
      ].join('.');
      const second = await startFlow(caller);
      mockSessionBackend(
        { accessToken: PASTE_ACCESS_TOKEN, user: { email: 'next@example.test' } },
        'next@example.test',
      );
      await caller.aiProviderOAuth.pollAuthStatus({
        deviceCode: second.started.deviceCode,
        id: 'chatgptweb',
        reason: 'reconnect with a fresh web session',
        sessionToken: secondJwe,
      });

      expect(await caller.aiProviderOAuth.getConnectionStatus({ id: 'chatgptweb' })).toMatchObject({
        accountEmail: 'next@example.test',
        canRefresh: true,
        renewalKind: 'web_session',
      });
      // The previous account's session must not survive under the new one.
      const [row] = await db.select().from(platformAiProviders);
      expect(row.encryptedKeyVaults).not.toContain(sessionJwe);
      expect(row.encryptedKeyVaults).not.toContain('s@example.test');
    });
  });

  /**
   * The finding this locks down: the create branch stored a provider with ZERO model rows,
   * while the admin model list — a merge of platform rows and the model-bank catalog — already
   * drew the card's defaults with the toggle ON and the connectivity check answered "check
   * model not enabled". The displayed state was a promise the database never made.
   */
  const connect = async (
    caller: Awaited<ReturnType<typeof callerFor>>,
    reason: string,
    email: string,
  ) => {
    const { started } = await startFlow(caller);
    mockSessionBackend({ accessToken: PASTE_ACCESS_TOKEN, user: { email } }, email);
    return caller.aiProviderOAuth.pollAuthStatus({
      deviceCode: started.deviceCode,
      id: 'chatgptweb',
      reason,
      sessionToken: sessionJwe,
    });
  };

  it('first connect materializes the card default-enabled models as enabled rows', async () => {
    const caller = await callerFor();
    expect(
      await connect(caller, 'connect the shared ChatGPT Web account', 'a@example.test'),
    ).toMatchObject({ status: 'success', stored: true });

    const rows = await db.select().from(platformAiModels);
    expect(rows.map((row) => row.modelKey).sort()).toEqual([
      'auto',
      'gpt-5-6',
      'gpt-5-6-instant',
      'gpt-5-6-pro',
      'gpt-5-6-thinking',
      'gpt-image-2',
    ]);
    expect(rows.every((row) => row.enabled)).toBe(true);
    // Both model types the card enables, not just the chat ones.
    expect(rows.find((row) => row.modelKey === 'gpt-image-2')?.type).toBe('image');
    // Card metadata, so the row is not an empty stub the list then contradicts.
    expect(rows.find((row) => row.modelKey === 'auto')).toMatchObject({
      contextWindowTokens: 128_000,
      displayName: 'Auto (ChatGPT Web)',
    });
    // Live, not a saved-but-unpublished draft.
    expect((await db.select().from(platformAiProviders))[0]).toMatchObject({
      status: 'published',
    });
  });

  it('reconnect leaves the materialized rows exactly as they were', async () => {
    const caller = await callerFor();
    await connect(caller, 'connect the shared ChatGPT Web account', 'a@example.test');
    const before = await db.select().from(platformAiModels);

    expect(
      await connect(caller, 'reconnect the shared ChatGPT Web account', 'b@example.test'),
    ).toMatchObject({ status: 'success', stored: true });

    const after = await db.select().from(platformAiModels);
    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it('seeds the models for an operator holding only the provider grants', async () => {
    // AI_MODEL_CREATE is deliberately NOT in this role: the seeded rows are the immutable
    // builtin card, not operator-authored models, so gating them behind it would only make a
    // legitimate shared-account connect fail outright.
    const caller = await callerFor({
      authenticatedAt: new Date(),
      authMethod: 'better-auth',
      userId: ids.providerOnly,
    });
    expect(
      await connect(caller, 'connect the shared ChatGPT Web account', 'a@example.test'),
    ).toMatchObject({ status: 'success', stored: true });
    expect(await db.select().from(platformAiModels)).toHaveLength(6);
  });
});
