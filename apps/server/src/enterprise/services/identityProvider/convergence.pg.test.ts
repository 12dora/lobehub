// @vitest-environment node
import { GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE } from '@lobechat/types';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { checksumPayload } from '@/database/models/platform';
import {
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformIdentityProviders,
  platformResourceRevisions,
} from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  getIdentityProviderProcessInstance,
  INSTANCE_CONVERGENCE_LOCK_NAMESPACE,
  INSTANCE_CONVERGENCE_LOCK_RESOURCE,
  registerIdentityProviderInstance,
  stopIdentityProviderHeartbeatForTest,
} from './instanceRegistry';
import type { RestartController } from './restartController';
import {
  commitIdentityProviderStartupSnapshot,
  resetIdentityProviderStartupArtifactForTest,
} from './startupArtifact';
import {
  IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT,
  IdentityProviderSystemService,
  loadPublishedIdentityTarget,
} from './systemService';

const runPostgres = process.env.TEST_SERVER_DB === '1';
const db: LobeChatDatabase = await getTestDB();
const now = new Date();
const controller: RestartController = {
  capability: () => ({ reason: null, supported: true }),
  schedule: async () => undefined,
};

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformIdentityProviders);
  await db.delete(platformResourceRevisions);
  resetIdentityProviderStartupArtifactForTest();
  stopIdentityProviderHeartbeatForTest();
};

const seed = async () => {
  const payload = {
    autoProvision: true,
    buttonLabel: 'Work account',
    claimMapping: GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.claimMapping,
    clientId: 'client-id',
    displayName: 'Work',
    domainAllowlist: [],
    enabled: true,
    groupRoleMapping: {},
    icon: null,
    issuer: 'https://login.example.test',
    providerKey: 'work',
    scopes: [...GENERIC_OIDC_IDENTITY_PROVIDER_TEMPLATE.scopes],
    secretFingerprint: 'b'.repeat(64),
    type: 'generic_oidc' as const,
    usePkce: true as const,
  };
  await db.insert(platformIdentityProviders).values({
    activationRevision: 1,
    buttonLabel: 'Work account',
    displayName: 'Work',
    enabled: true,
    id: 'provider-work',
    providerKey: 'work',
    revision: 1,
    status: 'pending_restart',
  });
  await db.insert(platformResourceRevisions).values({
    checksum: checksumPayload(payload),
    id: 'revision-work-1',
    payload,
    publishedAt: now,
    resourceId: 'provider-work',
    resourceType: 'oidc',
    revision: 1,
    secretFingerprint: payload.secretFingerprint,
    status: 'published',
  });
  const target = (await loadPublishedIdentityTarget(db)).identityRevision!;
  const local = getIdentityProviderProcessInstance();
  await db.insert(platformIdentityProviderInstances).values({
    activeIdentityRevision: target,
    health: 'healthy',
    hostnameHash: 'c'.repeat(64),
    instanceId: local.instanceId,
    lastHeartbeat: now,
    loadedAt: now,
    startedAt: new Date(now.getTime() - 120_000),
    startupGeneration: 'generation',
    startupSource: 'database',
  });
  commitIdentityProviderStartupSnapshot({
    databaseProviders: [],
    generation: 'generation',
    health: 'healthy',
    identityRevision: target,
    lastError: null,
    loadedAt: now,
    providerIds: ['work'],
    source: 'database',
  });
  return target;
};

beforeEach(cleanup);
afterEach(cleanup);

describe.skipIf(!runPostgres)('identity provider convergence PostgreSQL races', () => {
  it('serializes reconciliation behind a recovering mismatched heartbeat', async () => {
    const target = await seed();
    const remoteId = `oidci_${'d'.repeat(48)}`;
    await db.insert(platformIdentityProviderInstances).values({
      activeIdentityRevision: target,
      health: 'healthy',
      hostnameHash: 'e'.repeat(64),
      instanceId: remoteId,
      lastHeartbeat: now,
      loadedAt: now,
      startedAt: new Date(now.getTime() - 120_000),
      startupGeneration: 'generation',
      startupSource: 'database',
    });
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 2 });
    const client = await pool.connect();
    let settled = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        INSTANCE_CONVERGENCE_LOCK_NAMESPACE,
        INSTANCE_CONVERGENCE_LOCK_RESOURCE,
      ]);
      const statusPromise = new IdentityProviderSystemService(
        db,
        controller,
        () => now,
        () => undefined,
      )
        .getAuthSnapshotStatus()
        .finally(() => {
          settled = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      await client.query(
        `UPDATE platform_identity_provider_instances
            SET active_identity_revision = $1, last_heartbeat = clock_timestamp()
          WHERE instance_id = $2`,
        ['a'.repeat(64), remoteId],
      );
      await client.query('COMMIT');
      const status = await statusPromise;
      expect(status.active.allFreshInstancesActive).toBe(false);
      expect((await db.select().from(platformIdentityProviders))[0]?.status).toBe(
        'pending_restart',
      );
    } finally {
      if (!settled) await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await pool.end();
    }
  });

  it('checks every fresh instance beyond 200 before activating', async () => {
    const target = await seed();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    await pool.query(
      `INSERT INTO platform_identity_provider_instances
        (instance_id, startup_generation, startup_source, active_identity_revision, health,
         loaded_at, started_at, last_heartbeat, hostname_hash)
       SELECT 'oidci_' || lpad(to_hex(i), 48, '0'), 'generation', 'database',
              CASE WHEN i = 201 THEN $1 ELSE $2 END, 'healthy',
              clock_timestamp(), clock_timestamp() - interval '2 minutes', clock_timestamp(), $3
         FROM generate_series(1, 201) AS i`,
      ['a'.repeat(64), target, 'f'.repeat(64)],
    );
    await pool.end();
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status.instances).toHaveLength(202);
    expect(status.active.allFreshInstancesActive).toBe(false);
    expect(
      (
        await db
          .select()
          .from(platformIdentityProviders)
          .where(eq(platformIdentityProviders.id, 'provider-work'))
      )[0]?.status,
    ).toBe('pending_restart');
  });

  it('keeps exact stale aggregates while bounding deterministic stale diagnostics', async () => {
    await seed();
    const connectionString = process.env.DATABASE_TEST_URL;
    if (!connectionString) throw new Error('DATABASE_TEST_URL is required');
    const pool = new Pool({ connectionString, max: 1 });
    const staleCount = IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT + 5;
    await pool.query(
      `INSERT INTO platform_identity_provider_instances
        (instance_id, startup_generation, startup_source, active_identity_revision, health,
         loaded_at, started_at, last_heartbeat, hostname_hash)
       SELECT 'oidci_' || lpad(to_hex(i), 48, '0'), 'generation', 'database', $1, 'healthy',
              clock_timestamp() - interval '3 minutes',
              clock_timestamp() - interval '4 minutes',
              clock_timestamp() - interval '2 minutes' - i * interval '1 second', $2
         FROM generate_series(1, $3::int) AS i`,
      ['a'.repeat(64), 'f'.repeat(64), staleCount],
    );
    await pool.end();
    const status = await new IdentityProviderSystemService(
      db,
      controller,
      () => now,
      () => undefined,
    ).getAuthSnapshotStatus();
    expect(status.active.staleInstances).toBe(staleCount);
    expect(status.instances.filter(({ fresh }) => fresh)).toHaveLength(1);
    expect(
      status.instances.filter(({ fresh }) => !fresh).map(({ instanceId }) => instanceId),
    ).toEqual(
      Array.from(
        { length: IDENTITY_PROVIDER_RECENT_STALE_DIAGNOSTIC_LIMIT },
        (_, index) => `oidci_${(index + 1).toString(16).padStart(48, '0')}`,
      ),
    );
  });

  it('demotes an active DB provider when a matching environment provider becomes authoritative', async () => {
    const target = await seed();
    await db
      .update(platformIdentityProviders)
      .set({ status: 'active' })
      .where(eq(platformIdentityProviders.id, 'provider-work'));

    await registerIdentityProviderInstance({
      db,
      env: { AUTH_SSO_PROVIDERS: 'work', VERCEL: '1' },
      snapshot: {
        databaseProviders: [],
        generation: null,
        health: 'healthy',
        identityRevision: null,
        lastError: null,
        loadedAt: now,
        providerIds: ['work'],
        source: 'environment',
      },
    });

    expect(target).toMatch(/^[a-f0-9]{64}$/);
    expect(
      (
        await db
          .select()
          .from(platformIdentityProviders)
          .where(eq(platformIdentityProviders.id, 'provider-work'))
      )[0]?.status,
    ).toBe('pending_restart');
  });
});
