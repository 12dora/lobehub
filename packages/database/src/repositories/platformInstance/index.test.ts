// @vitest-environment node
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import {
  platformIdentityProviderInstances,
  platformIdentityProviderRestartRequests,
  platformInstanceHeartbeats,
  platformInstanceRevisionStates,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import {
  PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
  PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS,
  PLATFORM_INSTANCE_STALE_AFTER_MS,
  PlatformInstanceRepository,
} from '.';

const db: LobeChatDatabase = await getTestDB();
const repository = new PlatformInstanceRepository(db);
const instanceId = (digit: string) => `pinst_${digit.repeat(48)}`;
const identityId = (digit: string) => `oidci_${digit.repeat(48)}`;

const seedRegistry = async (input: {
  identity: Array<{ id: string; lastHeartbeat: Date }>;
  platform: Array<{ id: string; lastHeartbeatAt: Date }>;
}) => {
  if (input.platform.length > 0) {
    await db.insert(platformInstanceHeartbeats).values(
      input.platform.map(({ id, lastHeartbeatAt }) => ({
        instanceId: id,
        lastHeartbeatAt,
        startedAt: new Date(lastHeartbeatAt.getTime() - 60_000),
      })),
    );
  }
  if (input.identity.length > 0) {
    await db.insert(platformIdentityProviderInstances).values(
      input.identity.map(({ id, lastHeartbeat }) => ({
        activeIdentityRevision: null,
        health: 'healthy' as const,
        hostnameHash: 'c'.repeat(64),
        instanceId: id,
        lastHeartbeat,
        loadedAt: new Date(lastHeartbeat.getTime() - 60_000),
        startedAt: new Date(lastHeartbeat.getTime() - 60_000),
        startupSource: 'database' as const,
      })),
    );
  }
};

const insertRestartRequest = async (input: {
  createdAt: Date;
  requestId: string;
  targetInstanceId: string;
}) =>
  db.insert(platformIdentityProviderRestartRequests).values({
    actorId: 'purge-test-actor',
    createdAt: input.createdAt,
    expectedIdentityRevision: 'a'.repeat(64),
    expiresAt: new Date(input.createdAt.getTime() + 5 * 60 * 1000),
    intentTokenHash: 'b'.repeat(64),
    ownerFence: 'c'.repeat(64),
    payloadHash: 'd'.repeat(64),
    requestId: input.requestId,
    status: 'prepared',
    targetInstanceId: input.targetInstanceId,
  });

const cleanup = async () => {
  await db.delete(platformIdentityProviderRestartRequests);
  await db.delete(platformIdentityProviderInstances);
  await db.delete(platformInstanceRevisionStates);
  await db.delete(platformInstanceHeartbeats);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformInstanceRepository', () => {
  it('uses the fixed 30 second heartbeat and 90 second freshness windows', () => {
    expect(PLATFORM_INSTANCE_HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(PLATFORM_INSTANCE_STALE_AFTER_MS).toBe(90_000);
  });

  it('registers idempotently without changing process start time', async () => {
    const id = instanceId('1');
    await repository.registerInstance(id);
    await db
      .update(platformInstanceHeartbeats)
      .set({
        lastHeartbeatAt: sql`statement_timestamp() - interval '5 minutes'`,
        startedAt: sql`statement_timestamp() - interval '5 minutes'`,
      })
      .where(eq(platformInstanceHeartbeats.instanceId, id));

    const registered = await repository.registerInstance(id);

    expect(registered.startedAt.getTime()).toBeLessThan(Date.now() - 4 * 60_000);
    expect(registered.lastHeartbeatAt.getTime()).toBeLessThan(Date.now() - 4 * 60_000);
    expect(await db.select().from(platformInstanceHeartbeats)).toHaveLength(1);
  });

  it('converges concurrent heartbeat upserts to one row and preserves startedAt', async () => {
    const id = instanceId('2');
    const initial = await repository.registerInstance(id);

    const beats = await Promise.all(
      Array.from({ length: 12 }, () => repository.upsertHeartbeat(id)),
    );

    expect(new Set(beats.map((beat) => beat.instanceId))).toEqual(new Set([id]));
    const rows = await db.select().from(platformInstanceHeartbeats);
    expect(rows).toHaveLength(1);
    expect(rows[0].startedAt).toEqual(initial.startedAt);
    expect(rows[0].lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
      initial.lastHeartbeatAt.getTime(),
    );
  });

  it('derives freshness from the database clock without deleting stale rows', async () => {
    const staleId = instanceId('3');
    const freshId = instanceId('4');
    await Promise.all([repository.registerInstance(staleId), repository.upsertHeartbeat(freshId)]);
    await db
      .update(platformInstanceHeartbeats)
      .set({
        lastHeartbeatAt: sql`statement_timestamp() - interval '91 seconds'`,
        startedAt: sql`statement_timestamp() - interval '5 minutes'`,
      })
      .where(eq(platformInstanceHeartbeats.instanceId, staleId));

    expect((await repository.listFreshInstances()).map(({ instanceId }) => instanceId)).toEqual([
      freshId,
    ]);
    expect(await db.select().from(platformInstanceHeartbeats)).toHaveLength(2);
  });

  it('aggregates only fresh production identity revisions without returning instance identifiers', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const targetRevision = 'a'.repeat(64);
    const otherRevision = 'b'.repeat(64);
    const rows = [
      {
        activeIdentityRevision: targetRevision,
        health: 'healthy' as const,
        instanceId: `oidci_${'1'.repeat(48)}`,
        startupSource: 'database' as const,
      },
      {
        activeIdentityRevision: otherRevision,
        health: 'healthy' as const,
        instanceId: `oidci_${'2'.repeat(48)}`,
        startupSource: 'database' as const,
      },
      {
        activeIdentityRevision: targetRevision,
        degradedCategory: 'startup_snapshot_unavailable',
        health: 'degraded' as const,
        instanceId: `oidci_${'3'.repeat(48)}`,
        startupSource: 'database' as const,
      },
      {
        activeIdentityRevision: targetRevision,
        health: 'healthy' as const,
        instanceId: `oidci_${'4'.repeat(48)}`,
        startupSource: 'lkg' as const,
      },
      {
        activeIdentityRevision: otherRevision,
        health: 'healthy' as const,
        instanceId: `oidci_${'5'.repeat(48)}`,
        lastHeartbeat: new Date(cutoff.getTime() - 1),
        startupSource: 'database' as const,
      },
    ];
    await db.insert(platformIdentityProviderInstances).values(
      rows.map((row) => ({
        ...row,
        hostnameHash: 'c'.repeat(64),
        lastHeartbeat: row.lastHeartbeat ?? cutoff,
        loadedAt: new Date(cutoff.getTime() - 10_000),
        startedAt: new Date(cutoff.getTime() - 20_000),
      })),
    );

    const snapshot = await repository.getIdentityRevisionLagSnapshot(targetRevision, snapshotAt);

    expect(snapshot).toEqual({
      freshInstances: 4,
      laggingInstances: [
        { count: 2, reason: 'degraded' },
        { count: 1, reason: 'diverged' },
      ],
      snapshotAt,
    });
    expect(JSON.stringify(snapshot)).not.toContain('oidci_');
    expect(JSON.stringify(snapshot)).not.toContain(targetRevision);
  });

  it('treats a null published identity target as a real convergence target', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const startedAt = new Date(snapshotAt.getTime() - 10_000);
    await db.insert(platformIdentityProviderInstances).values([
      {
        activeIdentityRevision: null,
        health: 'healthy',
        hostnameHash: 'd'.repeat(64),
        instanceId: `oidci_${'6'.repeat(48)}`,
        lastHeartbeat: snapshotAt,
        loadedAt: startedAt,
        startedAt,
        startupSource: 'database',
      },
      {
        activeIdentityRevision: 'e'.repeat(64),
        health: 'healthy',
        hostnameHash: 'f'.repeat(64),
        instanceId: `oidci_${'7'.repeat(48)}`,
        lastHeartbeat: snapshotAt,
        loadedAt: startedAt,
        startedAt,
        startupSource: 'database',
      },
    ]);

    await expect(repository.getIdentityRevisionLagSnapshot(null, snapshotAt)).resolves.toEqual({
      freshInstances: 2,
      laggingInstances: [
        { count: 0, reason: 'degraded' },
        { count: 1, reason: 'diverged' },
      ],
      snapshotAt,
    });
  });

  it('upserts normalized revision state with database-authored loadedAt', async () => {
    const id = instanceId('5');
    await repository.registerInstance(id);
    const initial = await repository.upsertRevisionState({
      domain: 'settings',
      health: 'healthy',
      instanceId: id,
      loadedRevision: 1,
      loadMode: 'process_cached',
      source: 'database',
    });
    await db
      .update(platformInstanceRevisionStates)
      .set({ loadedAt: sql`clock_timestamp() - interval '1 day'` })
      .where(eq(platformInstanceRevisionStates.instanceId, id));

    const updated = await repository.upsertRevisionState({
      domain: 'settings',
      health: 'degraded',
      errorCategory: 'cache_unavailable',
      instanceId: id,
      loadedRevision: 2,
      loadedRevisionId: 'settings:2',
      loadMode: 'process_cached',
      source: 'lkg',
    });

    expect(updated.loadedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(updated.loadedAt.getTime()).toBeGreaterThan(initial.loadedAt.getTime());
    expect(updated).toMatchObject({
      errorCategory: 'cache_unavailable',
      health: 'degraded',
      loadedRevision: 2,
      loadedRevisionId: 'settings:2',
      source: 'lkg',
    });
    expect(await repository.listRevisionStates(id)).toEqual([updated]);
  });

  it('keeps one row per instance and domain under concurrent state reports', async () => {
    const id = instanceId('6');
    await repository.registerInstance(id);

    await Promise.all(
      Array.from({ length: 10 }, (_, loadedRevision) =>
        repository.upsertRevisionState({
          domain: 'ai_catalog',
          health: 'healthy',
          instanceId: id,
          loadedRevision,
          loadMode: 'process_cached',
          source: 'cache',
        }),
      ),
    );

    const states = await repository.listRevisionStates(id);
    expect(states).toHaveLength(1);
    expect(states[0].domain).toBe('ai_catalog');
  });

  it('uses one supplied database-clock boundary and excludes stale states from convergence', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const ids = [instanceId('a'), instanceId('b'), instanceId('c')];
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((id, index) => ({
        instanceId: id,
        lastHeartbeatAt: new Date(cutoff.getTime() - (index === 0 ? 0 : index === 1 ? 1 : -1)),
        startedAt: new Date(cutoff.getTime() - 10_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values([
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: ids[0],
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'settings',
        health: 'degraded',
        errorCategory: 'cache_unavailable',
        instanceId: ids[1],
        loadedRevision: 1,
        loadMode: 'process_cached',
        source: 'lkg',
      },
    ]);

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
      ],
      snapshotAt,
    );

    expect(snapshot).toMatchObject({ freshCount: 2, snapshotAt, staleCount: 1 });
    expect(snapshot.counts[0]).toEqual({
      counts: {
        degraded: 0,
        diverged: 0,
        fresh: 2,
        matching: 1,
        stale: 1,
        unreported: 1,
      },
      domain: 'settings',
    });
  });

  it('keeps exact counts while bounding and ordering fresh diagnostics issue-first', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const total = PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT + 4;
    const ids = Array.from(
      { length: total },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((id, index) => ({
        instanceId: id,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - index * 100),
        startedAt: new Date(snapshotAt.getTime() - 120_000),
      })),
    );
    await db.insert(platformInstanceRevisionStates).values(
      ids.map((id, index) => ({
        domain: 'settings' as const,
        health: 'healthy' as const,
        instanceId: id,
        loadedRevision: index === total - 1 ? 1 : 2,
        loadMode: 'process_cached' as const,
        source: 'database' as const,
      })),
    );

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
      ],
      snapshotAt,
    );

    expect(snapshot.freshCount).toBe(total);
    expect(snapshot.freshCandidates).toHaveLength(
      PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
    );
    expect(snapshot.freshCandidates[0]?.instance.instanceId).toBe(ids.at(-1));
    expect(snapshot.counts[0]?.counts).toMatchObject({ diverged: 1, matching: total - 1 });
    expect(snapshot.freshCandidates.every(({ states }) => states.length <= 8)).toBe(true);
  });

  it('aggregates multiple domains in one snapshot with independent token matchers', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    const matchingId = instanceId('a');
    const settingsDivergedId = instanceId('b');
    const brandingDegradedId = instanceId('c');
    const unreportedId = instanceId('d');
    const staleId = instanceId('e');
    const brandingToken = 'branding:rev-9';

    await db.insert(platformInstanceHeartbeats).values([
      {
        instanceId: matchingId,
        lastHeartbeatAt: snapshotAt,
        startedAt: new Date(snapshotAt.getTime() - 10_000),
      },
      {
        instanceId: settingsDivergedId,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - 1_000),
        startedAt: new Date(snapshotAt.getTime() - 10_000),
      },
      {
        instanceId: brandingDegradedId,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - 2_000),
        startedAt: new Date(snapshotAt.getTime() - 10_000),
      },
      {
        instanceId: unreportedId,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - 3_000),
        startedAt: new Date(snapshotAt.getTime() - 10_000),
      },
      {
        instanceId: staleId,
        lastHeartbeatAt: new Date(cutoff.getTime() - 1),
        startedAt: new Date(cutoff.getTime() - 10_000),
      },
    ]);
    await db.insert(platformInstanceRevisionStates).values([
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: matchingId,
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'branding',
        health: 'healthy',
        instanceId: matchingId,
        loadedRevisionId: brandingToken,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: settingsDivergedId,
        loadedRevision: 1,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'branding',
        health: 'healthy',
        instanceId: settingsDivergedId,
        loadedRevisionId: brandingToken,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: brandingDegradedId,
        loadedRevision: 2,
        loadMode: 'process_cached',
        source: 'database',
      },
      {
        domain: 'branding',
        errorCategory: 'cache_unavailable',
        health: 'degraded',
        instanceId: brandingDegradedId,
        loadedRevisionId: 'branding:old',
        loadMode: 'process_cached',
        source: 'lkg',
      },
      {
        domain: 'settings',
        health: 'healthy',
        instanceId: staleId,
        loadedRevision: 9,
        loadMode: 'process_cached',
        source: 'database',
      },
    ]);

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
        {
          domain: 'branding',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'immutable_id', value: brandingToken },
        },
        {
          domain: 'ai_catalog',
          loadMode: 'request_scoped',
          status: 'available',
          token: { kind: 'revision', value: 1 },
        },
        {
          domain: 'skill_catalog',
          loadMode: 'process_cached',
          status: 'disabled',
          token: null,
        },
      ],
      snapshotAt,
    );

    expect(snapshot.freshCount).toBe(4);
    expect(snapshot.staleCount).toBe(1);
    expect(snapshot.counts.map(({ domain }) => domain)).toEqual([
      'settings',
      'branding',
      'ai_catalog',
      'skill_catalog',
    ]);
    expect(snapshot.counts[0]).toEqual({
      counts: {
        degraded: 0,
        diverged: 1,
        fresh: 4,
        matching: 2,
        stale: 1,
        unreported: 1,
      },
      domain: 'settings',
    });
    expect(snapshot.counts[1]).toEqual({
      counts: {
        degraded: 1,
        diverged: 0,
        fresh: 4,
        matching: 2,
        stale: 1,
        unreported: 1,
      },
      domain: 'branding',
    });
    expect(snapshot.counts[2]).toEqual({
      counts: {
        degraded: 0,
        diverged: 0,
        fresh: 4,
        matching: 0,
        stale: 1,
        unreported: 0,
      },
      domain: 'ai_catalog',
    });
    expect(snapshot.counts[3]).toEqual({
      counts: {
        degraded: 0,
        diverged: 0,
        fresh: 4,
        matching: 0,
        stale: 1,
        unreported: 0,
      },
      domain: 'skill_catalog',
    });

    const issueIds = snapshot.freshCandidates.map(({ instance }) => instance.instanceId);
    expect(issueIds[0]).toBe(settingsDivergedId);
    expect(issueIds.slice(0, 3)).toEqual(
      expect.arrayContaining([settingsDivergedId, brandingDegradedId, unreportedId]),
    );
    expect(issueIds.indexOf(settingsDivergedId)).toBeLessThan(issueIds.indexOf(matchingId));
    expect(snapshot.staleCandidates.map(({ instance }) => instance.instanceId)).toEqual([staleId]);
  });

  it('returns empty inventory snapshot counts for empty targets without failing', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    await db.insert(platformInstanceHeartbeats).values({
      instanceId: instanceId('f'),
      lastHeartbeatAt: snapshotAt,
      startedAt: new Date(snapshotAt.getTime() - 5_000),
    });

    const snapshot = await repository.getConvergenceInventorySnapshot([], snapshotAt);

    expect(snapshot).toEqual({
      counts: [],
      freshCandidates: [
        {
          instance: expect.objectContaining({ instanceId: instanceId('f') }),
          states: [],
        },
      ],
      freshCount: 1,
      snapshotAt,
      staleCandidates: [],
      staleCount: 0,
    });
  });

  it('honors diagnostic candidate limit while preserving issue-first multi-domain order', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const total = PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT + 6;
    const ids = Array.from(
      { length: total },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values(
      ids.map((id, index) => ({
        instanceId: id,
        lastHeartbeatAt: new Date(snapshotAt.getTime() - index * 100),
        startedAt: new Date(snapshotAt.getTime() - 120_000),
      })),
    );
    // Newest heartbeat (ids[0]) only diverges on branding; oldest (ids.at(-1)) only on settings.
    await db.insert(platformInstanceRevisionStates).values([
      ...ids.map((id, index) => ({
        domain: 'settings' as const,
        health: 'healthy' as const,
        instanceId: id,
        loadedRevision: index === total - 1 ? 1 : 2,
        loadMode: 'process_cached' as const,
        source: 'database' as const,
      })),
      ...ids.map((id, index) => ({
        domain: 'branding' as const,
        health: 'healthy' as const,
        instanceId: id,
        loadedRevisionId: index === 0 ? 'branding:wrong' : 'branding:ok',
        loadMode: 'process_cached' as const,
        source: 'database' as const,
      })),
    ]);

    const snapshot = await repository.getConvergenceInventorySnapshot(
      [
        {
          domain: 'settings',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'revision', value: 2 },
        },
        {
          domain: 'branding',
          loadMode: 'process_cached',
          status: 'available',
          token: { kind: 'immutable_id', value: 'branding:ok' },
        },
      ],
      snapshotAt,
    );

    expect(snapshot.freshCandidates).toHaveLength(
      PLATFORM_INSTANCE_FRESH_DIAGNOSTIC_CANDIDATE_LIMIT,
    );
    // Issue-first: branding-divergent newest instance precedes matching mid-list instances.
    expect(snapshot.freshCandidates[0]?.instance.instanceId).toBe(ids[0]);
    // Settings-divergent oldest remains among the bounded issue set (only two issues total).
    expect(snapshot.freshCandidates.map(({ instance }) => instance.instanceId)).toEqual(
      expect.arrayContaining([ids[0], ids.at(-1)]),
    );
    expect(snapshot.counts).toEqual([
      {
        counts: {
          degraded: 0,
          diverged: 1,
          fresh: total,
          matching: total - 1,
          stale: 0,
          unreported: 0,
        },
        domain: 'settings',
      },
      {
        counts: {
          degraded: 0,
          diverged: 1,
          fresh: total,
          matching: total - 1,
          stale: 0,
          unreported: 0,
        },
        domain: 'branding',
      },
    ]);
  });

  it('keyset-paginates the complete mixed revision inventory across equal heartbeats', async () => {
    const freshHeartbeat = new Date('2030-01-01T00:10:00.000Z');
    const staleHeartbeat = new Date('2030-01-01T00:08:00.000Z');
    const startedAt = new Date('2030-01-01T00:00:00.000Z');
    const platformFreshIds = Array.from(
      { length: 103 },
      (_, index) => `pinst_${index.toString(16).padStart(48, '0')}`,
    );
    const identityFreshIds = Array.from(
      { length: 3 },
      (_, index) => `oidci_${index.toString(16).padStart(48, '0')}`,
    );
    const platformStaleIds = Array.from(
      { length: 12 },
      (_, index) => `pinst_${(1000 + index).toString(16).padStart(48, '0')}`,
    );
    const identityStaleIds = Array.from(
      { length: 2 },
      (_, index) => `oidci_${(1000 + index).toString(16).padStart(48, '0')}`,
    );
    await db.insert(platformInstanceHeartbeats).values([
      ...platformFreshIds.map((instanceId) => ({
        instanceId,
        lastHeartbeatAt: freshHeartbeat,
        startedAt,
      })),
      ...platformStaleIds.map((instanceId) => ({
        instanceId,
        lastHeartbeatAt: staleHeartbeat,
        startedAt,
      })),
    ]);
    await db.insert(platformIdentityProviderInstances).values(
      [...identityFreshIds, ...identityStaleIds].map((instanceId, index) => ({
        activeIdentityRevision: null,
        health: 'healthy' as const,
        hostnameHash: index.toString(16).padStart(64, '0'),
        instanceId,
        lastHeartbeat: index < identityFreshIds.length ? freshHeartbeat : staleHeartbeat,
        loadedAt: startedAt,
        startedAt,
        startupSource: 'database' as const,
      })),
    );

    const collected: string[] = [];
    let cursor: { instanceId: string; lastHeartbeatAt: Date } | undefined;
    do {
      const page = await repository.listRevisionInventoryPage({ cursor, limit: 17 });
      collected.push(...page.items.map(({ instance }) => instance.instanceId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const expected = [
      ...identityFreshIds.sort(),
      ...platformFreshIds.sort(),
      ...identityStaleIds.sort(),
      ...platformStaleIds.sort(),
    ];
    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(expected.length);
    expect(collected.at(0)).toBe(identityFreshIds[0]);
    expect(collected.at(-1)).toBe(platformStaleIds.at(-1));
  });

  it('filters the inventory page by freshness against the supplied snapshot clock', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    await seedRegistry({
      identity: [
        { id: identityId('1'), lastHeartbeat: snapshotAt },
        { id: identityId('2'), lastHeartbeat: new Date(cutoff.getTime() - 1) },
      ],
      platform: [
        { id: instanceId('a'), lastHeartbeatAt: snapshotAt },
        { id: instanceId('b'), lastHeartbeatAt: new Date(cutoff.getTime() - 1) },
      ],
    });

    const read = async (freshness: 'all' | 'live' | 'offline') =>
      (await repository.listRevisionInventoryPage({ freshness, snapshotAt })).items
        .map(({ instance }) => instance.instanceId)
        .sort();

    await expect(read('live')).resolves.toEqual([identityId('1'), instanceId('a')].sort());
    await expect(read('offline')).resolves.toEqual([identityId('2'), instanceId('b')].sort());
    await expect(read('all')).resolves.toHaveLength(4);
  });

  it('counts live and offline registrations across both process registries', async () => {
    const snapshotAt = new Date('2030-01-01T00:10:00.000Z');
    const cutoff = new Date(snapshotAt.getTime() - PLATFORM_INSTANCE_STALE_AFTER_MS);
    await seedRegistry({
      identity: [
        { id: identityId('1'), lastHeartbeat: snapshotAt },
        { id: identityId('2'), lastHeartbeat: new Date(cutoff.getTime() - 1) },
        { id: identityId('3'), lastHeartbeat: new Date(cutoff.getTime() - 60_000) },
      ],
      platform: [
        { id: instanceId('a'), lastHeartbeatAt: cutoff },
        { id: instanceId('b'), lastHeartbeatAt: new Date(cutoff.getTime() - 1) },
      ],
    });

    await expect(repository.countInstancesByFreshness(snapshotAt)).resolves.toEqual({
      live: 2,
      offline: 3,
    });
  });

  it('purges expired restart intents before their instances and never local or live rows', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const localIdentity = identityId('1');
    const localPlatform = instanceId('a');
    const expiredIdentity = identityId('2');
    const expiredPlatform = instanceId('b');
    await seedRegistry({
      identity: [
        { id: localIdentity, lastHeartbeat: new Date(cutoff.getTime() - 60_000) },
        { id: expiredIdentity, lastHeartbeat: new Date(cutoff.getTime() - 60_000) },
        { id: identityId('3'), lastHeartbeat: now },
      ],
      platform: [
        { id: localPlatform, lastHeartbeatAt: new Date(cutoff.getTime() - 60_000) },
        { id: expiredPlatform, lastHeartbeatAt: new Date(cutoff.getTime() - 60_000) },
        { id: instanceId('c'), lastHeartbeatAt: now },
      ],
    });
    await db.insert(platformInstanceRevisionStates).values({
      domain: 'settings',
      health: 'healthy',
      instanceId: expiredPlatform,
      loadedRevision: 1,
      loadMode: 'process_cached',
      source: 'database',
    });
    // Intent older than the cutoff: blocks the FK until it is deleted first.
    await insertRestartRequest({
      createdAt: new Date(cutoff.getTime() - 120_000),
      requestId: '550e8400-e29b-41d4-a716-446655440001',
      targetInstanceId: expiredIdentity,
    });

    const result = await repository.purgeOfflineInstances({
      cutoff,
      keepInstanceIds: [localIdentity, localPlatform],
    });

    expect(result).toEqual({ identityInstances: 1, platformInstances: 1, restartRequests: 1 });
    expect(
      (await db.select().from(platformIdentityProviderInstances))
        .map(({ instanceId }) => instanceId)
        .sort(),
    ).toEqual([localIdentity, identityId('3')].sort());
    expect(
      (await db.select().from(platformInstanceHeartbeats))
        .map(({ instanceId }) => instanceId)
        .sort(),
    ).toEqual([localPlatform, instanceId('c')].sort());
    // platform_instance_revision_states is ON DELETE CASCADE.
    expect(await db.select().from(platformInstanceRevisionStates)).toEqual([]);
    expect(await db.select().from(platformIdentityProviderRestartRequests)).toEqual([]);
  });

  it('skips an offline instance still referenced by a retained restart request', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const referenced = identityId('2');
    await seedRegistry({
      identity: [
        { id: referenced, lastHeartbeat: new Date(cutoff.getTime() - 60_000) },
        { id: identityId('3'), lastHeartbeat: new Date(cutoff.getTime() - 60_000) },
      ],
      platform: [],
    });
    // Newer than the cutoff, so the intent survives and its target must survive with it.
    await insertRestartRequest({
      createdAt: new Date(now.getTime() - 60_000),
      requestId: '550e8400-e29b-41d4-a716-446655440002',
      targetInstanceId: referenced,
    });

    const result = await repository.purgeOfflineInstances({ cutoff });

    expect(result).toMatchObject({ identityInstances: 1, restartRequests: 0 });
    expect(
      (await db.select().from(platformIdentityProviderInstances)).map(
        ({ instanceId }) => instanceId,
      ),
    ).toEqual([referenced]);
  });

  it('bounds one purge pass by the requested batch size', async () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    await seedRegistry({
      identity: [],
      platform: Array.from({ length: 5 }, (_, index) => ({
        id: `pinst_${index.toString(16).padStart(48, '0')}`,
        lastHeartbeatAt: new Date(cutoff.getTime() - (index + 1) * 1000),
      })),
    });

    await expect(repository.purgeOfflineInstances({ cutoff, limit: 2 })).resolves.toMatchObject({
      platformInstances: 2,
    });
    expect(await db.select().from(platformInstanceHeartbeats)).toHaveLength(3);
  });
});
