// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformAdminMutationRateWindows } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformAdminMutationRateModel } from './adminMutationRate';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformAdminMutationRateWindows);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformAdminMutationRateModel (PostgreSQL)', () => {
  it('allows through the boundary and denies above it with independent scopes', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scopeA = { limit: 2, scopeDigest: 'a'.repeat(64), windowMs: 60_000 };
    const scopeB = { limit: 2, scopeDigest: 'b'.repeat(64), windowMs: 60_000 };

    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(model.consume(scopeA)).resolves.toMatchObject({ allowed: false, count: 3 });
    await expect(model.consume(scopeB)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('shares state across independent model instances', async () => {
    const first = new PlatformAdminMutationRateModel(db);
    const second = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 2, scopeDigest: 'c'.repeat(64), windowMs: 60_000 };

    await expect(first.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(second.consume(scope)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(first.consume(scope)).resolves.toMatchObject({ allowed: false, count: 3 });
  });

  it('handles concurrent boundary races without under-counting', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 5, scopeDigest: 'd'.repeat(64), windowMs: 60_000 };
    const results = await Promise.all(Array.from({ length: 20 }, () => model.consume(scope)));
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;
    expect(allowed).toBe(5);
    expect(denied).toBe(15);
    expect(Math.max(...results.map((r) => r.count))).toBe(20);
  });

  it('rolls the window using the database clock after window expiry', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const scope = { limit: 1, scopeDigest: 'e'.repeat(64), windowMs: 50 };

    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: false, count: 2 });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(model.consume(scope)).resolves.toMatchObject({ allowed: true, count: 1 });
  });

  it('never stores raw actor identifiers', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    await model.consume({
      limit: 3,
      scopeDigest: 'f'.repeat(64),
      windowMs: 60_000,
    });
    const rows = await db.select().from(platformAdminMutationRateWindows);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeDigest).toBe('f'.repeat(64));
    expect(JSON.stringify(rows)).not.toMatch(/user-|admin\./);
  });

  it('cleanupExpired deletes only stale windows in bounded batches without expanding live quota', async () => {
    const model = new PlatformAdminMutationRateModel(db);
    const live = { limit: 2, scopeDigest: '1'.repeat(64), windowMs: 60_000 };

    // Live scope via normal consume (fresh window_start).
    await model.consume(live);

    // Stale rows: window_start far in the past so cleanup can select them by age.
    const staleStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 30; i++) {
      const digest = `${i.toString(16).padStart(2, '0')}${'a'.repeat(62)}`;
      await db.insert(platformAdminMutationRateWindows).values({
        count: 1,
        scopeDigest: digest,
        updatedAt: staleStart,
        windowStart: staleStart,
      });
    }

    const deleted = await model.cleanupExpired({
      limit: 10,
      maxAgeMs: 24 * 60 * 60 * 1000,
    });
    expect(deleted).toBe(10);

    // Live scope still exact: second consume allowed, third limited.
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: true, count: 2 });
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: false, count: 3 });

    // Concurrent cleanup must not expand quota on a saturated scope.
    await Promise.all([
      model.cleanupExpired({ limit: 50, maxAgeMs: 24 * 60 * 60 * 1000 }),
      model.cleanupExpired({ limit: 50, maxAgeMs: 24 * 60 * 60 * 1000 }),
    ]);
    await expect(model.consume(live)).resolves.toMatchObject({ allowed: false });
  });
});
