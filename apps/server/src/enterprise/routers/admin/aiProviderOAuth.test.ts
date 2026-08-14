// @vitest-environment node
/**
 * admin.aiProviderOAuth — shared platform device-flow connection.
 * Covers provider admission, the reauth gate on both steps (asserted before the
 * single-use grant is redeemed), the pending/no-write path, the create and reconnect
 * store branches with their audits, sanitized failure audits, and the presence-only
 * projection of the status query.
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
    // Storing publishes unconditionally, so a successful poll is always live.
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
        value: {
          oauthAccessToken: ACCESS_TOKEN,
          oauthAccountEmail: ACCOUNT_EMAIL,
          oauthAccountId: ACCOUNT_ID,
          oauthRefreshToken: REFRESH_TOKEN,
          oauthTokenExpiresAt: expect.stringMatching(/^\d+$/),
        },
      },
    });
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
      connected: true,
      expired: false,
      expiresAt: expect.stringMatching(/^\d+$/),
      secretConfigured: true,
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(ACCOUNT_ID);
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
      connected: false,
      expired: false,
      expiresAt: null,
      secretConfigured: false,
    });
  });
});
