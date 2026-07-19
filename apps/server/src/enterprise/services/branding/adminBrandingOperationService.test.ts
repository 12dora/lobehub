// @vitest-environment node
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformBrandingOperations } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';

import {
  AdminBrandingOperationService,
  BrandingIdempotencyConflictError,
  BrandingOperationOwnershipLostError,
} from './adminBrandingOperationService';

const db: LobeChatDatabase = await getTestDB();
const actorId = 'branding-operation-admin';
const operation = 'admin.branding.saveDraft' as const;
const resource = 'branding:global';

const request = (requestId = crypto.randomUUID(), fingerprint = 'a'.repeat(64)) => ({
  actorId,
  fingerprint,
  operation,
  requestId,
  resource,
});

const cleanup = async () => {
  await db
    .delete(platformBrandingOperations)
    .where(eq(platformBrandingOperations.actorId, actorId));
};

beforeEach(cleanup);
afterEach(cleanup);

describe('AdminBrandingOperationService', () => {
  it('replays the exact success result and permanently conflicts on another fingerprint', async () => {
    const service = new AdminBrandingOperationService(db);
    const params = request();
    const acquired = await service.claim(params);
    expect(acquired.state).toBe('acquired');
    if (acquired.state !== 'acquired') throw new Error('expected operation claim');
    const result = {
      baseRevision: 2,
      draftToken: 'b'.repeat(64),
      kind: 'saveDraft' as const,
      ok: true as const,
    };
    await db.transaction((tx) => service.succeed(tx, acquired.claim, result));

    await expect(service.claim(params)).resolves.toEqual({ result, state: 'succeeded' });
    await expect(service.claim({ ...params, fingerprint: 'c'.repeat(64) })).rejects.toBeInstanceOf(
      BrandingIdempotencyConflictError,
    );
  });

  it('persists a stable failed category without depending on a failure audit', async () => {
    const service = new AdminBrandingOperationService(db);
    const params = request();
    const acquired = await service.claim(params);
    if (acquired.state !== 'acquired') throw new Error('expected operation claim');
    await service.fail(acquired.claim, 'revision_conflict');

    await expect(service.claim(params)).resolves.toEqual({
      errorCategory: 'revision_conflict',
      state: 'failed',
    });
    await expect(service.claim({ ...params, fingerprint: 'd'.repeat(64) })).rejects.toBeInstanceOf(
      BrandingIdempotencyConflictError,
    );
  });

  it('returns one acquisition and one deterministic pending result under concurrency', async () => {
    const service = new AdminBrandingOperationService(db);
    const params = request();
    const states = await Promise.all([service.claim(params), service.claim(params)]);

    expect(states.map(({ state }) => state).sort()).toEqual(['acquired', 'pending']);
    expect(await db.select().from(platformBrandingOperations)).toHaveLength(1);
  });

  it('recovers an expired lease and fences the crashed owner from committing', async () => {
    let now = new Date('2026-07-19T00:00:00.000Z');
    const service = new AdminBrandingOperationService(db, { now: () => now });
    const params = request();
    const crashed = await service.claim(params);
    if (crashed.state !== 'acquired') throw new Error('expected operation claim');

    now = new Date('2026-07-19T00:06:00.000Z');
    const recovered = await service.claim(params);
    if (recovered.state !== 'acquired') throw new Error('expected recovered claim');
    expect(recovered.claim.id).toBe(crashed.claim.id);
    expect(recovered.claim.owner).not.toBe(crashed.claim.owner);

    await expect(
      db.transaction((tx) =>
        service.succeed(tx, crashed.claim, {
          baseRevision: 1,
          draftToken: 'e'.repeat(64),
          kind: 'saveDraft',
          ok: true,
        }),
      ),
    ).rejects.toBeInstanceOf(BrandingOperationOwnershipLostError);
    await db.transaction((tx) =>
      service.succeed(tx, recovered.claim, {
        baseRevision: 1,
        draftToken: 'f'.repeat(64),
        kind: 'saveDraft',
        ok: true,
      }),
    );
    await expect(service.claim(params)).resolves.toMatchObject({ state: 'succeeded' });
  });
});
