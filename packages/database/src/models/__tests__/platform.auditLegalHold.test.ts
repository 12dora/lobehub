// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAuditLegalHolds } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAuditLegalHoldModel } from '../platform/auditLegalHold';

const serverDB: LobeChatDatabase = await getTestDB();
const model = new PlatformAuditLegalHoldModel(serverDB);

afterEach(async () => {
  await serverDB.delete(platformAuditLegalHolds);
});

describe('PlatformAuditLegalHoldModel', () => {
  it('creates scoped holds and stores global scopeId as null (no sentinel)', async () => {
    const userHold = await model.create({
      createdBy: 'admin-1',
      reason: 'litigation hold for user',
      scopeId: 'user-a',
      scopeType: 'user',
    });
    expect(userHold.id).toMatch(/^palh_/);
    expect(userHold.status).toBe('active');
    expect(userHold.scopeType).toBe('user');
    expect(userHold.scopeId).toBe('user-a');
    expect(userHold.createdBy).toBe('admin-1');

    const globalHold = await model.create({
      createdBy: 'admin-1',
      reason: 'org-wide freeze',
      scopeType: 'global',
    });
    expect(globalHold.scopeType).toBe('global');
    expect(globalHold.scopeId).toBeNull();
  });

  it('rejects non-null scopeId for global and requires scopeId for non-global', async () => {
    await expect(
      model.create({
        createdBy: 'admin-1',
        reason: 'bad global',
        scopeId: '*',
        scopeType: 'global',
      }),
    ).rejects.toThrow(/scopeId must be null for global/);

    await expect(
      model.create({ createdBy: 'admin-1', reason: 'missing scope', scopeType: 'session' }),
    ).rejects.toThrow(/scopeId is required/);
  });

  it('requires non-null createdBy', async () => {
    await expect(
      model.create({
        // @ts-expect-error intentional
        createdBy: '',
        reason: 'x',
        scopeId: 'user-a',
        scopeType: 'user',
      }),
    ).rejects.toThrow(/createdBy is required/);
  });

  it('enforces at most one active hold per non-global scope and one active global', async () => {
    await model.create({
      createdBy: 'admin-1',
      reason: 'first',
      scopeId: 'user-a',
      scopeType: 'user',
    });
    await expect(
      model.create({
        createdBy: 'admin-2',
        reason: 'duplicate',
        scopeId: 'user-a',
        scopeType: 'user',
      }),
    ).rejects.toThrow();

    await model.create({
      createdBy: 'admin-1',
      reason: 'global first',
      scopeType: 'global',
    });
    await expect(
      model.create({
        createdBy: 'admin-2',
        reason: 'global duplicate',
        scopeType: 'global',
      }),
    ).rejects.toThrow();
  });

  it('release requires releasedBy + non-empty releaseReason; allows re-create after release', async () => {
    const hold = await model.create({
      createdBy: 'admin-1',
      reason: 'temp hold',
      scopeId: 'topic-1',
      scopeType: 'topic',
    });

    await expect(
      model.release(hold.id, {
        // @ts-expect-error intentional
        releaseReason: '',
        releasedBy: 'admin-2',
      }),
    ).rejects.toThrow(/releaseReason/);

    await expect(
      model.release(hold.id, {
        releaseReason: 'case closed',
        // @ts-expect-error intentional
        releasedBy: '',
      }),
    ).rejects.toThrow(/releasedBy/);

    const released = await model.release(hold.id, {
      releaseReason: 'case closed',
      releasedBy: 'admin-2',
    });
    expect(released?.status).toBe('released');
    expect(released?.releasedBy).toBe('admin-2');
    expect(released?.releaseReason).toBe('case closed');
    expect(released?.releasedAt).toBeInstanceOf(Date);

    // second release is a no-op
    await expect(
      model.release(hold.id, { releaseReason: 'again', releasedBy: 'admin-2' }),
    ).resolves.toBeUndefined();

    const again = await model.create({
      createdBy: 'admin-1',
      reason: 're-open',
      scopeId: 'topic-1',
      scopeType: 'topic',
    });
    expect(again.status).toBe('active');
  });

  it('lists with filters/pagination and createdBy isolation', async () => {
    const t0 = new Date('2026-07-01T00:00:00.000Z');
    await serverDB.insert(platformAuditLegalHolds).values([
      {
        createdAt: t0,
        createdBy: 'admin-1',
        id: 'palh_0000000000000003',
        reason: 'u1',
        scopeId: 'user-a',
        scopeType: 'user',
        status: 'active',
      },
      {
        createdAt: t0,
        createdBy: 'admin-2',
        id: 'palh_0000000000000002',
        reason: 'ws1',
        scopeId: 'ws-1',
        scopeType: 'workspace',
        status: 'active',
      },
      {
        createdAt: t0,
        createdBy: 'admin-1',
        id: 'palh_0000000000000001',
        reason: 'old',
        scopeId: 'user-b',
        scopeType: 'user',
        status: 'released',
        releasedAt: t0,
        releasedBy: 'admin-1',
        releaseReason: 'done',
      },
    ]);

    const active = await model.list({ status: 'active' });
    expect(active.items).toHaveLength(2);

    const byCreator = await model.list({ createdBy: 'admin-1' });
    expect(byCreator.items.every((r) => r.createdBy === 'admin-1')).toBe(true);

    const page1 = await model.list({ limit: 1, scopeType: 'user' });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await model.list({ cursor: page1.nextCursor!, limit: 10, scopeType: 'user' });
    expect(page2.items.map((r) => r.id)).toEqual(['palh_0000000000000001']);
  });

  it('findActiveScopes returns matching holds including global; excludes expired', async () => {
    await model.create({
      createdBy: 'admin-1',
      reason: 'user hold',
      scopeId: 'user-a',
      scopeType: 'user',
    });
    await model.create({
      createdBy: 'admin-1',
      reason: 'session hold',
      scopeId: 'ssn-1',
      scopeType: 'session',
    });
    await model.create({
      createdBy: 'admin-1',
      reason: 'global',
      scopeType: 'global',
    });
    // released must not match
    const released = await model.create({
      createdBy: 'admin-1',
      reason: 'old workspace',
      scopeId: 'ws-old',
      scopeType: 'workspace',
    });
    await model.release(released.id, {
      releaseReason: 'closed',
      releasedBy: 'admin-1',
    });

    // expired active hold must not match
    await model.create({
      createdBy: 'admin-1',
      expiresAt: new Date('2020-01-01T00:00:00.000Z'),
      reason: 'expired topic',
      scopeId: 'topic-expired',
      scopeType: 'topic',
    });

    const matches = await model.findActiveScopes([
      { scopeId: 'user-a', scopeType: 'user' },
      { scopeId: 'user-b', scopeType: 'user' },
      { scopeId: 'ssn-1', scopeType: 'session' },
      { scopeId: 'topic-expired', scopeType: 'topic' },
    ]);

    const keys = matches.map((m) => `${m.scopeType}:${m.scopeId ?? 'null'}`).toSorted();
    expect(keys).toEqual(['global:null', 'session:ssn-1', 'user:user-a']);

    // user-b has no direct hold, but global still blocks
    await expect(model.hasActiveHold([{ scopeId: 'user-b', scopeType: 'user' }])).resolves.toBe(
      true,
    );

    // workspace-only query without direct hold still returns global if present
    const onlyWs = await model.findActiveScopes([{ scopeId: 'ws-other', scopeType: 'workspace' }]);
    expect(onlyWs.map((m) => m.scopeType)).toEqual(['global']);
    expect(onlyWs[0]?.scopeId).toBeNull();
  });

  it('get returns undefined for missing ids', async () => {
    await expect(model.get('palh_missing')).resolves.toBeUndefined();
  });
});
