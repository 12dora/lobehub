// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import { platformConnectorSecrets, platformJobs } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import { type KeyProvider, PlatformSecretService } from '../../security/secret';
import type { ConnectorCatalogSecretStore } from './catalogTypes';
import { PlatformConnectorSecretStore } from './platformConnectorSecretStore';
import {
  __resetConnectorSecretCleanupGcThrottleForTests,
  cleanupConnectorSecretRefs,
  CONNECTOR_SECRET_CLEANUP_JOB_TYPE,
  reconcileConnectorSecretCleanups,
} from './secretCleanup';
import {
  __resetConnectorSecretCleanupWorkerForTests,
  ensureConnectorSecretCleanupWorkerStarted,
  isConnectorSecretCleanupReconcilerConfigured,
  runConnectorSecretCleanupBatch,
} from './secretCleanupWorker';

const connectorId = 'm09-secret-cleanup-a';
const keyA = new Uint8Array(32).fill(7);

/** Attach the required secret-source loader without altering cleanup behaviour under test. */
const asCleanupStore = (
  store: Omit<ConnectorCatalogSecretStore, 'loadCurrentSecretSources'> &
    Partial<Pick<ConnectorCatalogSecretStore, 'loadCurrentSecretSources'>>,
): ConnectorCatalogSecretStore => ({
  loadCurrentSecretSources: async () => ({}),
  ...store,
});

let db: LobeChatDatabase;

const cleanup = async () => {
  await db
    .delete(platformConnectorSecrets)
    .where(eq(platformConnectorSecrets.connectorId, connectorId));
  await db.delete(platformJobs).where(eq(platformJobs.type, CONNECTOR_SECRET_CLEANUP_JOB_TYPE));
};

beforeEach(async () => {
  db = await getTestDB();
  await cleanup();
  __resetConnectorSecretCleanupGcThrottleForTests();
  const repository = new PlatformConnectorCatalogRepository(db);
  try {
    await repository.createConnector({
      connectorKey: connectorId,
      credentialMode: 'none',
      displayName: connectorId,
      endpoint: 'https://connector.example.test/mcp',
      id: connectorId,
    });
  } catch {
    // Connector may already exist across suite re-runs.
  }
}, 60_000);

afterEach(async () => {
  __resetConnectorSecretCleanupWorkerForTests();
  __resetConnectorSecretCleanupGcThrottleForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
});

describe('connector secret cleanup durability', () => {
  it('enqueues exact-ref cleanup and revokes after reconciler when immediate revoke fails', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const stored = await store.persistSecret({
      connectorId,
      slot: 'oauthBindingToken',
      value: { accessToken: 'detached-token' },
    });

    // Detach from live references so GC/reconcile may revoke.
    // Immediate revoke fails once (timeout/outage); durable job must retain the exact ref.
    let attempts = 0;
    const flakyStore = {
      garbageCollectOrphanedSecrets: store.garbageCollectOrphanedSecrets.bind(store),
      persistSecret: store.persistSecret.bind(store),
      resolveSecretRef: store.resolveSecretRef.bind(store),
      resolveSecretVersion: store.resolveSecretVersion.bind(store),
      revokeSecretRef: async (params: {
        connectorId: string;
        ref: string;
        slot: 'oauthBindingToken' | 'oauthClientSecret' | 'oauthPkceVerifier' | 'sharedSecret';
      }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('secret revoke timeout');
        await store.revokeSecretRef(params);
      },
    };

    await cleanupConnectorSecretRefs(
      asCleanupStore(flakyStore),
      [{ connectorId, ref: stored.ref, slot: 'oauthBindingToken' }],
      { db },
    );

    // Row still active after the failed immediate attempt.
    await expect(
      store.resolveSecretRef({
        connectorId,
        ref: stored.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toMatchObject({ ref: stored.ref });

    const pendingJobs = await db
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.type, CONNECTOR_SECRET_CLEANUP_JOB_TYPE));
    expect(pendingJobs).toHaveLength(1);
    expect(pendingJobs[0]).toMatchObject({
      idempotencyKey: `${connectorId}:oauthBindingToken:${stored.ref}`,
      status: 'pending',
    });
    expect(pendingJobs[0]!.input).toMatchObject({
      connectorId,
      ref: stored.ref,
      slot: 'oauthBindingToken',
    });

    // Reconciler replays the exact reference (no grace wait) and clears the job.
    await expect(
      reconcileConnectorSecretCleanups(db, asCleanupStore(flakyStore)),
    ).resolves.toMatchObject({
      completed: 1,
      failed: 0,
    });

    await expect(
      store.resolveSecretRef({
        connectorId,
        ref: stored.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();

    const after = await db
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.type, CONNECTOR_SECRET_CLEANUP_JOB_TYPE));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('succeeded');
  });

  it('batch entrypoint drains a pending cleanup job end-to-end', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const stored = await store.persistSecret({
      connectorId,
      slot: 'oauthBindingToken',
      value: { accessToken: 'batch-drain-token' },
    });

    let attempts = 0;
    const flakyStore = {
      garbageCollectOrphanedSecrets: store.garbageCollectOrphanedSecrets.bind(store),
      persistSecret: store.persistSecret.bind(store),
      resolveSecretRef: store.resolveSecretRef.bind(store),
      resolveSecretVersion: store.resolveSecretVersion.bind(store),
      revokeSecretRef: async (params: {
        connectorId: string;
        ref: string;
        slot: 'oauthBindingToken' | 'oauthClientSecret' | 'oauthPkceVerifier' | 'sharedSecret';
      }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('secret revoke timeout');
        await store.revokeSecretRef(params);
      },
    };

    await cleanupConnectorSecretRefs(
      asCleanupStore(flakyStore),
      [{ connectorId, ref: stored.ref, slot: 'oauthBindingToken' }],
      { db },
    );

    // Production drain path used by the poller / serverless cron — not the bare reconciler.
    await expect(
      runConnectorSecretCleanupBatch(db, asCleanupStore(flakyStore)),
    ).resolves.toMatchObject({
      completed: 1,
      failed: 0,
    });

    await expect(
      store.resolveSecretRef({
        connectorId,
        ref: stored.ref,
        slot: 'oauthBindingToken',
      }),
    ).resolves.toBeNull();

    const after = await db
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.type, CONNECTOR_SECRET_CLEANUP_JOB_TYPE));
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe('succeeded');
  });

  it('does not exhaust attempt budget within a single batch on transient revoke failure', async () => {
    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const stored = await store.persistSecret({
      connectorId,
      slot: 'oauthBindingToken',
      value: { accessToken: 'backoff-token' },
    });

    let revokeCalls = 0;
    const alwaysFailStore = {
      garbageCollectOrphanedSecrets: vi.fn().mockResolvedValue(0),
      persistSecret: store.persistSecret.bind(store),
      resolveSecretRef: store.resolveSecretRef.bind(store),
      resolveSecretVersion: store.resolveSecretVersion.bind(store),
      revokeSecretRef: async () => {
        revokeCalls += 1;
        throw new Error('secret revoke timeout');
      },
    };

    await cleanupConnectorSecretRefs(
      asCleanupStore(alwaysFailStore),
      [{ connectorId, ref: stored.ref, slot: 'oauthBindingToken' }],
      { db },
    );
    // cleanupConnectorSecretRefs already tried once (failed → enqueued).
    const enqueuedRevokeCalls = revokeCalls;

    await expect(
      reconcileConnectorSecretCleanups(db, asCleanupStore(alwaysFailStore), { limit: 50 }),
    ).resolves.toMatchObject({
      completed: 0,
      failed: 1,
    });

    // One claim + fail, then break — must not burn all 12 attempts in this batch.
    expect(revokeCalls - enqueuedRevokeCalls).toBe(1);

    const [job] = await db
      .select()
      .from(platformJobs)
      .where(eq(platformJobs.type, CONNECTOR_SECRET_CLEANUP_JOB_TYPE));
    expect(job).toMatchObject({
      status: 'pending',
    });
    expect(job!.attempt).toBeLessThan(12);
    expect(job!.status).not.toBe('dead');
  });

  it('throttles orphan GC so idle claim ticks do not re-scan every pass', async () => {
    const gc = vi.fn().mockResolvedValue(0);
    const store = {
      garbageCollectOrphanedSecrets: gc,
      persistSecret: async () => {
        throw new Error('unused');
      },
      resolveSecretRef: async () => null,
      resolveSecretVersion: async () => {
        throw new Error('unused');
      },
      revokeSecretRef: async () => {},
    };

    const storeWithSources = asCleanupStore(store);
    await reconcileConnectorSecretCleanups(db, storeWithSources);
    await reconcileConnectorSecretCleanups(db, storeWithSources);
    await reconcileConnectorSecretCleanups(db, storeWithSources);
    // First pass runs GC; subsequent idle passes within the throttle window skip.
    expect(gc).toHaveBeenCalledTimes(1);
  });

  it('reports reconciler availability for persistent, serverless opt-in, and bare Vercel', () => {
    expect(
      isConnectorSecretCleanupReconcilerConfigured({
        DATABASE_URL: 'postgres://local',
        NODE_ENV: 'production',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).toBe(true);
    expect(
      isConnectorSecretCleanupReconcilerConfigured({
        CONNECTOR_SECRET_CLEANUP_RECONCILE_ENABLED: '1',
        VERCEL_ENV: 'production',
      }),
    ).toBe(true);
    expect(
      isConnectorSecretCleanupReconcilerConfigured({
        VERCEL_ENV: 'production',
      }),
    ).toBe(false);
    expect(isConnectorSecretCleanupReconcilerConfigured({})).toBe(true);
  });

  it('serverless batch entrypoint remains available without starting the poller', async () => {
    // Vercel skips the persistent poller; the cron/batch path must still drain.
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('NODE_ENV', 'production');
    ensureConnectorSecretCleanupWorkerStarted();

    const keyProvider: KeyProvider = {
      getKek: async () => ({ key: keyA, keyId: 'test:key-a' }),
      providerId: 'test',
    };
    const store = new PlatformConnectorSecretStore(db, new PlatformSecretService({ keyProvider }));
    const stored = await store.persistSecret({
      connectorId,
      slot: 'oauthBindingToken',
      value: { accessToken: 'vercel-batch-token' },
    });

    let attempts = 0;
    const flakyStore = {
      garbageCollectOrphanedSecrets: store.garbageCollectOrphanedSecrets.bind(store),
      persistSecret: store.persistSecret.bind(store),
      resolveSecretRef: store.resolveSecretRef.bind(store),
      resolveSecretVersion: store.resolveSecretVersion.bind(store),
      revokeSecretRef: async (params: {
        connectorId: string;
        ref: string;
        slot: 'oauthBindingToken' | 'oauthClientSecret' | 'oauthPkceVerifier' | 'sharedSecret';
      }) => {
        attempts += 1;
        if (attempts === 1) throw new Error('secret revoke timeout');
        await store.revokeSecretRef(params);
      },
    };

    await cleanupConnectorSecretRefs(
      asCleanupStore(flakyStore),
      [{ connectorId, ref: stored.ref, slot: 'oauthBindingToken' }],
      { db },
    );
    await expect(
      runConnectorSecretCleanupBatch(db, asCleanupStore(flakyStore)),
    ).resolves.toMatchObject({
      completed: 1,
      failed: 0,
    });
  });

  it('starts a single non-overlapping unref poller under persistent production runtime', async () => {
    const pollerTimers: Array<{ unref: ReturnType<typeof vi.fn> }> = [];
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    // Only intercept the worker's 5s reschedule; leave other timers (waitFor, DB) alone.
    // Use mockImplementation once with an untyped callback — `as typeof setTimeout` fails
    // because Node's setTimeout includes `__promisify__` that a plain fn cannot satisfy.
    setTimeoutSpy.mockImplementation((fn: any, ms?: any, ...args: any[]) => {
      if (typeof ms === 'number' && ms >= 1000) {
        const unref = vi.fn();
        const handle = realSetTimeout(() => undefined, 1) as ReturnType<typeof setTimeout> & {
          unref?: () => void;
        };
        handle.unref = unref;
        pollerTimers.push({ unref });
        return handle;
      }
      return realSetTimeout(fn, ms, ...args);
    });

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DATABASE_URL', 'postgres://local');
    // Clear serverless markers so isPersistentEnterpriseWorkerRuntime is true.
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    // Force getServerDB to fail fast under production (no vault secret) so run()
    // hits finally → schedule without opening a real connection.
    delete process.env.KEY_VAULTS_SECRET;

    ensureConnectorSecretCleanupWorkerStarted();
    ensureConnectorSecretCleanupWorkerStarted();

    // run() is async: wait until its finally schedules the next poll.
    await vi.waitFor(() => {
      expect(pollerTimers).toHaveLength(1);
    });
    const pollerCalls = setTimeoutSpy.mock.calls.filter(
      (call) => typeof call[1] === 'number' && (call[1] as number) >= 1000,
    );
    expect(pollerCalls).toHaveLength(1);
    expect(pollerTimers[0]?.unref).toHaveBeenCalledOnce();
  });

  it('workers bootstrap registry wires ensureConnectorSecretCleanupWorkerStarted', () => {
    const bootstrapSource = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../bootstrap/workersBootstrap.ts',
      ),
      'utf8',
    );
    expect(bootstrapSource).toContain('connectorSecretCleanup');
    expect(bootstrapSource).toContain('ensureConnectorSecretCleanupWorkerStarted');
  });
});
