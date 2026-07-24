// @vitest-environment node
import { eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { getServerDB } from '@/database/core/db-adaptor';
import { getTestDB } from '@/database/core/getTestDB';
import {
  permissions,
  platformAuditLogs,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformIdentityProviderTestAttempts,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { createCallerFactory } from '@/libs/trpc/lambda';
import { createContextInner } from '@/libs/trpc/lambda/context';
import { getEnterpriseErrorBody } from '@/server/enterprise/guards/enterpriseErrors';
import { PlatformSecretService } from '@/server/enterprise/security/secret';

import { adminRouter } from '../admin';

const db: LobeChatDatabase = await getTestDB();
const createCaller = createCallerFactory(adminRouter);
const ids = {
  creator: 'm11-idp-creator',
  deleter: 'm11-idp-deleter',
  reader: 'm11-idp-reader',
  updater: 'm11-idp-updater',
};
const roleNames = ['m11_idp_reader', 'm11_idp_updater', 'm11_idp_deleter', 'm11_idp_creator'];

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(async () => db),
}));

const cleanup = async () => {
  // Append-only audit + related identity fixtures need trigger bypass for teardown.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.delete(platformIdentityProviderTestAttempts);
    await tx.delete(platformIdentityProviderSecrets);
    await tx.delete(platformIdentityProviders);
    await tx.delete(platformAuditLogs);
  });
  const ownedRoles = await db
    .select({ id: roles.id })
    .from(roles)
    .where(inArray(roles.name, roleNames));
  if (ownedRoles.length > 0) {
    const roleIds = ownedRoles.map(({ id }) => id);
    await db.delete(userRoles).where(inArray(userRoles.roleId, roleIds));
    await db.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await db.delete(roles).where(inArray(roles.id, roleIds));
  }
  await db.delete(users).where(sql`${users.id} LIKE 'm11-idp-%'`);
};

const grant = async (userId: string, name: string, code: string) => {
  const [role] = await db.insert(roles).values({ displayName: name, name }).returning();
  const [permission] = await db
    .select({ id: permissions.id })
    .from(permissions)
    .where(eq(permissions.code, code));
  await db.insert(rolePermissions).values({ permissionId: permission.id, roleId: role.id });
  await db.insert(userRoles).values({ roleId: role.id, userId, workspaceId: null });
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('APP_URL', 'https://app.example.test');
  vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  vi.stubEnv('PLATFORM_MASTER_KEY', Buffer.alloc(32, 51).toString('base64'));
  await cleanup();
  await db.insert(users).values(Object.values(ids).map((id) => ({ id })));
  await seedPlatformRoles(db);
  await grant(ids.reader, roleNames[0], PLATFORM_PERMISSIONS.IDENTITY_READ);
  await grant(ids.updater, roleNames[1], PLATFORM_PERMISSIONS.IDENTITY_UPDATE);
  await grant(ids.deleter, roleNames[2], PLATFORM_PERMISSIONS.IDENTITY_DELETE);
  await grant(ids.creator, roleNames[3], PLATFORM_PERMISSIONS.IDENTITY_CREATE);
});

afterEach(async () => {
  await cleanup();
  vi.unstubAllEnvs();
});

const callerFor = async (
  userId: string,
  auth: {
    authenticatedAt?: Date | null;
    authMethod?: 'api-key' | 'better-auth';
  } = { authenticatedAt: new Date(), authMethod: 'better-auth' },
) => {
  const context = await createContextInner({
    authenticatedAt: auth.authenticatedAt,
    authMethod: auth.authMethod ?? 'better-auth',
    sessionId: `session-${userId}`,
    userId,
  });
  return createCaller({ ...context, serverDB: db } as never).identityProviders;
};

const identityInput = (
  providerKey: string,
  secret: { operation: 'clear' | 'keep' } | { operation: 'replace'; value: string },
  reason = 'identity provider change',
) => ({
  autoProvision: true,
  buttonLabel: 'Sign in',
  claimMapping: {
    dingtalkTitle: [],
    dingtalkUserId: [],
    email: ['email'],
    name: ['name'],
    picture: [],
    subject: ['sub'],
  },
  clientId: 'client',
  displayName: providerKey,
  domainAllowlist: [],
  groupRoleMapping: {},
  icon: null,
  issuer: 'https://login.example.test',
  providerKey,
  reason,
  scopes: ['openid'],
  secret,
  type: 'generic_oidc' as const,
  usePkce: true as const,
});

describe('admin.identityProviders RBAC and feature gate', () => {
  it('conditionally gates create secret replace and clear for every unsupported auth state', async () => {
    const authStates = [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ];
    let attempt = 0;
    for (const auth of authStates) {
      for (const operation of ['replace', 'clear'] as const) {
        const providerKey = `guarded-create-${attempt++}`;
        const secretValue = `identity-create-value-${attempt}`;
        const secret =
          operation === 'replace'
            ? ({ operation, value: secretValue } as const)
            : ({ operation } as const);
        await expect(
          (await callerFor(ids.creator, auth)).create(
            identityInput(
              providerKey,
              secret,
              operation === 'replace' ? `denied ${secretValue}` : 'denied clear',
            ),
          ),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    }

    expect(await db.select().from(platformIdentityProviders)).toEqual([]);
    expect(await db.select().from(platformIdentityProviderSecrets)).toEqual([]);
    const audits = (await db.select().from(platformAuditLogs)).filter(
      ({ action }) => action === 'admin.identityProviders.create',
    );
    expect(audits).toHaveLength(6);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: ids.creator,
          afterDiff: { error: 'reauth_required' },
          reason: 'denied [REDACTED]',
          result: 'denied',
          targetId: 'guarded-create-0',
          targetType: 'identity_provider',
        }),
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain('identity-create-value');
  });

  it('conditionally gates update secret replace and clear before draft or secret writes', async () => {
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({ displayName: 'guarded-update', providerKey: 'guarded-update' })
      .returning();
    const authStates = [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ];
    let attempt = 0;
    for (const auth of authStates) {
      for (const operation of ['replace', 'clear'] as const) {
        const secretValue = `identity-update-value-${attempt++}`;
        const secret =
          operation === 'replace'
            ? ({ operation, value: secretValue } as const)
            : ({ operation } as const);
        await expect(
          (await callerFor(ids.updater, auth)).update({
            ...identityInput(
              'guarded-update',
              secret,
              operation === 'replace' ? `denied ${secretValue}` : 'denied clear',
            ),
            displayName: `denied-${attempt}`,
            expectedRevision: provider.revision,
            id: provider.id,
          }),
        ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      }
    }

    expect(
      await db
        .select({
          displayName: platformIdentityProviders.displayName,
          revision: platformIdentityProviders.revision,
        })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, provider.id)),
    ).toEqual([{ displayName: 'guarded-update', revision: 0 }]);
    expect(await db.select().from(platformIdentityProviderSecrets)).toEqual([]);
    const audits = (await db.select().from(platformAuditLogs)).filter(
      ({ action }) => action === 'admin.identityProviders.update',
    );
    expect(audits).toHaveLength(6);
    expect(audits.every(({ reason }) => reason === null)).toBe(true);
    expect(
      audits.every(
        ({ actorUserId, afterDiff, result, targetId, targetType }) =>
          actorUserId === ids.updater &&
          JSON.stringify(afterDiff) === JSON.stringify({ error: 'reauth_required' }) &&
          result === 'denied' &&
          targetId === provider.id &&
          targetType === 'identity_provider',
      ),
    ).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('identity-update-value');
  });

  it('redacts the current identity secret and fails closed when ciphertext is unreadable', async () => {
    const currentSecret = 'opaque-current-value-7319';
    const nextSecret = 'opaque-next-value-8421';
    const provider = await (
      await callerFor(ids.creator)
    ).create(identityInput('current-secret-guard', { operation: 'replace', value: currentSecret }));
    const stale = await callerFor(ids.updater, {
      authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
      authMethod: 'better-auth',
    });

    await expect(
      stale.update({
        ...identityInput('current-secret-guard', { operation: 'clear' }, `denied ${currentSecret}`),
        expectedRevision: provider.revision,
        id: provider.id,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      stale.update({
        ...identityInput(
          'current-secret-guard',
          { operation: 'replace', value: nextSecret },
          `denied ${currentSecret} and ${nextSecret}`,
        ),
        expectedRevision: provider.revision,
        id: provider.id,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await db
      .update(platformIdentityProviderSecrets)
      .set({ ciphertext: 'not-readable-ciphertext' })
      .where(eq(platformIdentityProviderSecrets.providerId, provider.id));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      stale.update({
        ...identityInput('current-secret-guard', { operation: 'clear' }, 'denied unreadable'),
        expectedRevision: provider.revision,
        id: provider.id,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const audits = (await db.select().from(platformAuditLogs)).filter(
      ({ action, result }) => action === 'admin.identityProviders.update' && result === 'denied',
    );
    expect(audits).toHaveLength(3);
    expect(audits.slice(0, 2).map(({ reason }) => reason)).toEqual([
      'denied [REDACTED]',
      'denied [REDACTED] and [REDACTED]',
    ]);
    expect(audits[2]?.reason).toBeNull();
    expect(JSON.stringify(audits)).not.toContain(currentSecret);
    expect(JSON.stringify(audits)).not.toContain(nextSecret);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(currentSecret);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(nextSecret);
    expect(
      await db
        .select({ revision: platformIdentityProviders.revision })
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, provider.id)),
    ).toEqual([{ revision: provider.revision }]);
    consoleError.mockRestore();
  });

  it('redacts opaque replacement and current secrets from success and failure mutation audits', async () => {
    // identity/F5: success-path and failure-path audits must never retain opaque secrets
    // that an admin pasted into the free-text reason (denied-reauth path already covered).
    const currentSecret = 'opaque-success-current-x7k9m2p4q8';
    const nextSecret = 'opaque-success-next-z3n5w1v6b0';
    const failureSecret = 'opaque-failure-replacement-j4h8';
    const created = await (
      await callerFor(ids.creator)
    ).create(
      identityInput(
        'opaque-audit-success',
        { operation: 'replace', value: currentSecret },
        `seed with ${currentSecret}`,
      ),
    );

    const rotated = await (
      await callerFor(ids.updater)
    ).update({
      ...identityInput(
        'opaque-audit-success',
        { operation: 'replace', value: nextSecret },
        `rotate using ${currentSecret} then ${nextSecret}`,
      ),
      expectedRevision: created.revision,
      id: created.id,
    });
    expect(rotated.secret.configured).toBe(true);

    await expect(
      (await callerFor(ids.updater)).update({
        ...identityInput(
          'opaque-audit-success',
          { operation: 'replace', value: failureSecret },
          `stale rev with ${nextSecret} and ${failureSecret}`,
        ),
        // Stale CAS: server head is rotated.revision; this must fail after reason sanitization.
        expectedRevision: created.revision,
        id: created.id,
      }),
    ).rejects.toBeTruthy();

    const providerSuccess = (await db.select().from(platformAuditLogs)).filter(
      (row) =>
        row.result === 'success' &&
        (row.targetId === created.id || row.targetId === 'opaque-audit-success') &&
        (row.action === 'admin.identityProviders.create' ||
          row.action === 'admin.identityProviders.update'),
    );
    const providerFailure = (await db.select().from(platformAuditLogs)).filter(
      (row) =>
        row.result === 'failure' &&
        row.targetId === created.id &&
        row.action === 'admin.identityProviders.update',
    );

    expect(providerSuccess.length).toBeGreaterThanOrEqual(2);
    expect(providerFailure.length).toBeGreaterThanOrEqual(1);

    const serialized = JSON.stringify([...providerSuccess, ...providerFailure]);
    expect(serialized).not.toContain(currentSecret);
    expect(serialized).not.toContain(nextSecret);
    expect(serialized).not.toContain(failureSecret);

    for (const row of providerSuccess) {
      expect(String(row.reason ?? '')).toContain('[REDACTED]');
    }
    for (const row of providerFailure) {
      expect(String(row.reason ?? '')).toContain('[REDACTED]');
    }
  });

  it('does not over-gate update keep, permits fresh replacement, and still forbids create keep', async () => {
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({ displayName: 'ordinary-keep', providerKey: 'ordinary-keep' })
      .returning();
    const kept = await (
      await callerFor(ids.updater, { authenticatedAt: null })
    ).update({
      ...identityInput('ordinary-keep', { operation: 'keep' }),
      expectedRevision: provider.revision,
      id: provider.id,
    });
    expect(kept).toMatchObject({ id: provider.id, secret: { configured: false } });
    await expect(
      (await callerFor(ids.updater)).update({
        ...identityInput('ordinary-keep', {
          operation: 'replace',
          value: 'fresh-identity-update-secret',
        }),
        expectedRevision: kept.revision,
        id: provider.id,
      }),
    ).resolves.toMatchObject({ id: provider.id, secret: { configured: true } });

    const created = await (
      await callerFor(ids.creator)
    ).create(
      identityInput('fresh-create', {
        operation: 'replace',
        value: 'fresh-identity-create-secret',
      }),
    );
    expect(created.secret.configured).toBe(true);
    await expect(
      (await callerFor(ids.creator, { authenticatedAt: null })).create(
        identityInput('invalid-keep', { operation: 'keep' }),
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('still rejects create replacement when the denied audit sink fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });
    await expect(
      (await callerFor(ids.creator, { authenticatedAt: null })).create(
        identityInput('audit-failure', {
          operation: 'replace',
          value: 'never-written-identity-secret',
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await db.select().from(platformIdentityProviders)).toEqual([]);
    expect(await db.select().from(platformIdentityProviderSecrets)).toEqual([]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('never-written-identity-secret');
    insert.mockRestore();
    consoleError.mockRestore();
  });

  it('keeps read and update permissions separate', async () => {
    const reader = await callerFor(ids.reader);
    await expect(reader.list({ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    await expect(reader.listPublishedRevisions({ id: 'missing' })).resolves.toEqual([]);
    await expect(
      reader.update({
        autoProvision: true,
        buttonLabel: 'Sign in',
        claimMapping: {
          dingtalkTitle: [],
          dingtalkUserId: [],
          email: ['email'],
          name: ['name'],
          picture: [],
          subject: ['sub'],
        },
        clientId: 'client',
        displayName: 'Work',
        domainAllowlist: [],
        expectedRevision: 0,
        groupRoleMapping: {},
        icon: null,
        id: 'missing',
        issuer: 'https://login.example.test',
        providerKey: 'work',
        reason: 'try update',
        scopes: ['openid'],
        secret: { operation: 'keep' },
        type: 'generic_oidc',
        usePkce: true,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const updater = await callerFor(ids.updater);
    await expect(updater.list({ limit: 10 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects at the feature gate before constructing the secret-dependent runtime', async () => {
    const reader = await callerFor(ids.reader);
    vi.stubEnv('ENABLE_DATABASE_OIDC', '0');
    vi.stubEnv('PLATFORM_MASTER_KEY', 'not-a-key');
    vi.mocked(getServerDB).mockClear();
    const select = vi.spyOn(db, 'select');
    const secretFactory = vi.spyOn(PlatformSecretService, 'fromEnvOrThrowIfEnterprise');
    await expect(reader.list({ limit: 10 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PLATFORM_FEATURE_DISABLED',
    });
    expect(getServerDB).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(secretFactory).not.toHaveBeenCalled();
    select.mockRestore();
    secretFactory.mockRestore();
  });

  it('surfaces PLATFORM_SECRET_REQUIRED when Database OIDC is on but master key is missing', async () => {
    // Real deploy path: flag on → secret factory throws PlatformSecretError with
    // .code=PLATFORM_SECRET_REQUIRED and a prose message (not the code string).
    vi.stubEnv('ENABLE_DATABASE_OIDC', '1');
    vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
    vi.stubEnv('PLATFORM_MASTER_KEY', '');
    vi.stubEnv('APP_URL', 'https://app.example.test');

    const reader = await callerFor(ids.reader);
    let thrown: unknown;
    try {
      await reader.list({ limit: 10 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeDefined();
    // Client-visible structured code used by isIdentityProviderSetupGuidanceError.
    expect(getEnterpriseErrorBody(thrown)?.code).toBe(
      PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED,
    );
    expect(thrown).toMatchObject({ message: PLATFORM_ERROR_CODES.PLATFORM_SECRET_REQUIRED });
    // Must not collapse into the generic invalid-input fallback.
    expect(getEnterpriseErrorBody(thrown)?.code).not.toBe(
      PLATFORM_ERROR_CODES.PLATFORM_INVALID_INPUT,
    );
  });

  it('requires recent reauth before deleting a draft and remains denied if audit fails', async () => {
    const [provider] = await db
      .insert(platformIdentityProviders)
      .values({ displayName: 'Delete guarded provider', providerKey: 'delete-guarded' })
      .returning();
    const input = {
      expectedRevision: provider.revision,
      id: provider.id,
      reason: 'delete unused identity provider draft',
    };
    for (const auth of [
      { authenticatedAt: null, authMethod: 'better-auth' as const },
      {
        authenticatedAt: new Date(Date.now() - 60 * 60 * 1000),
        authMethod: 'better-auth' as const,
      },
      { authenticatedAt: new Date(), authMethod: 'api-key' as const },
    ]) {
      await expect((await callerFor(ids.deleter, auth)).delete(input)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    await expect(
      db
        .select()
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, provider.id)),
    ).resolves.toHaveLength(1);
    expect(
      (await db.select().from(platformAuditLogs)).filter(
        ({ action }) => action === 'admin.identityProviders.delete',
      ),
    ).toMatchObject([
      { afterDiff: { error: 'reauth_required' }, result: 'denied' },
      { afterDiff: { error: 'reauth_required' }, result: 'denied' },
      { afterDiff: { error: 'reauth_required' }, result: 'denied' },
    ]);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('audit sink unavailable');
    });
    await expect(
      (await callerFor(ids.deleter, { authenticatedAt: null })).delete(input),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      db
        .select()
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, provider.id)),
    ).resolves.toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[admin.identityProviders] reauth denied audit unavailable',
      expect.objectContaining({
        action: 'admin.identityProviders.delete',
        errorClass: 'Error',
      }),
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(provider.id);
    insert.mockRestore();
    consoleError.mockRestore();
    await expect((await callerFor(ids.deleter)).delete(input)).resolves.toEqual({ deleted: true });
    await expect(
      db
        .select()
        .from(platformIdentityProviders)
        .where(eq(platformIdentityProviders.id, provider.id)),
    ).resolves.toEqual([]);
  });
});
