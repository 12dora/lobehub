// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';

import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformAuditLogs, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { createCallerFactory } from '@/libs/trpc/lambda';
import {
  type KekMaterial,
  type KeyProvider,
  PlatformSecretService,
} from '@/server/enterprise/security/secret';

import { PLATFORM_SECRET_REWRAP_JOB_TYPE } from '../../services/secretRewrap/contracts';
import { createAdminAuthorizationFixture } from '../../testing/adminAuthorizationFixture';
import { adminRouter } from '../admin';

let db: LobeChatDatabase;
const createCaller = createCallerFactory(adminRouter);
const fixture = createAdminAuthorizationFixture({ namespace: 'secret-rotation-router' });
const targetKeyId = 'vault:router-next';

const keyProvider: KeyProvider = {
  getKek: async (): Promise<KekMaterial> => ({
    key: new Uint8Array(randomBytes(32)),
    keyId: targetKeyId,
  }),
  providerId: 'vault',
};
const secrets = new PlatformSecretService({ keyProvider });

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(async () => db) }));

beforeAll(async () => {
  db = await getTestDB();
});

const cleanupJobs = async () => {
  const parentIds = (
    await db
      .select({ id: platformJobs.id })
      .from(platformJobs)
      .where(
        and(
          eq(platformJobs.type, PLATFORM_SECRET_REWRAP_JOB_TYPE),
          eq(platformJobs.requestedBy, fixture.actors.superAdmin),
        ),
      )
  ).map(({ id }) => id);
  if (parentIds.length > 0) {
    await db
      .delete(platformJobs)
      .where(inArray(sql<string>`${platformJobs.input}->>'parentJobId'`, parentIds));
    await db.delete(platformJobs).where(inArray(platformJobs.id, parentIds));
  }
};

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv('ENABLE_PLATFORM_ADMIN', '1');
  await cleanupJobs();
  await fixture.setup(db);
  vi.spyOn(PlatformSecretService, 'tryFromEnv').mockReturnValue(secrets);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupJobs();
  await fixture.cleanup(db);
  vi.unstubAllEnvs();
});

describe('admin.security.secretRotation router', () => {
  it('enforces the six global role packages for read and critical mutation paths', async () => {
    const contexts = await fixture.createContexts(db);
    await expect(
      createCaller(contexts.superAdmin as never).security.secretRotation.list(),
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(
      createCaller(contexts.auditor as never).security.secretRotation.list(),
    ).resolves.toEqual({ items: [], nextCursor: null });

    for (const context of [
      contexts.aiAdmin,
      contexts.identityAdmin,
      contexts.userAdmin,
      contexts.normal,
    ]) {
      await expect(
        createCaller(context as never).security.secretRotation.list(),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    const mutation = {
      reason: 'rotate all platform secret envelopes',
      requestId: randomUUID(),
      targetKeyId,
    };
    for (const context of [
      contexts.auditor,
      contexts.aiAdmin,
      contexts.identityAdmin,
      contexts.userAdmin,
      contexts.normal,
    ]) {
      await expect(
        createCaller(context as never).security.secretRotation.start(mutation),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    const started = await createCaller(contexts.superAdmin as never).security.secretRotation.start(
      mutation,
    );
    await expect(
      createCaller(contexts.auditor as never).security.secretRotation.get({
        jobId: started.jobId,
      }),
    ).resolves.toMatchObject({
      counts: {
        externalArtifactGate: 'identity_lkg_instance_convergence_required',
        historicalKeyRemovalReady: false,
      },
      jobId: started.jobId,
      status: 'pending',
    });
  });

  it('denies stale reauthentication before mutation and writes a sanitized audit', async () => {
    const contexts = await fixture.createContexts(db);
    const requestId = randomUUID();
    await expect(
      createCaller(contexts.staleReauthSuper as never).security.secretRotation.start({
        reason: 'rotate after the approved maintenance window',
        requestId,
        targetKeyId,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: 'ADMIN_REAUTH_REQUIRED' });

    const [audit] = await db
      .select()
      .from(platformAuditLogs)
      .where(eq(platformAuditLogs.requestId, requestId));
    expect(audit).toMatchObject({
      action: 'admin.security.secretRotation.start',
      afterDiff: { error: 'reauth_required' },
      result: 'denied',
      targetType: 'secret_rotation',
    });
    expect(JSON.stringify(audit)).not.toMatch(/ciphertext|secret=|Bearer|stack/i);
  });
});
