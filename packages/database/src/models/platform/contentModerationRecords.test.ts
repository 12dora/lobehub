// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MODERATION_DEFAULT_CATEGORY_POLICY } from '@/const/platform/contentModeration';

import { getTestDB } from '../../core/getTestDB';
import { platformContentModerationRecords } from '../../schemas/platform';
import { users } from '../../schemas/user';
import type { LobeChatDatabase } from '../../type';
import { PlatformContentModerationRecordModel } from './contentModerationRecords';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformContentModerationRecords);
  await db.delete(users);
};

beforeEach(cleanup);
afterEach(cleanup);

const baseInsert = () => ({
  categoryScores: { sexual: 0.9 },
  effectiveAction: 'block' as const,
  model: 'gpt-4o',
  policyAction: 'block' as const,
  promptExcerpt: 'hello',
  promptHash: 'hash-1',
  provider: 'openai',
  requestKind: 'chat' as const,
  source: 'keyword' as const,
  thresholdSnapshot: MODERATION_DEFAULT_CATEGORY_POLICY,
});

describe('PlatformContentModerationRecordModel', () => {
  it('inserts a record without selecting prompt_full and reports hasFullPrompt', async () => {
    const model = new PlatformContentModerationRecordModel(db);
    const inserted = await model.insert({
      ...baseInsert(),
      promptFull: 'secret full prompt',
    });
    expect(inserted.hasFullPrompt).toBe(true);
    expect(inserted).not.toHaveProperty('promptFull');
    expect(await model.getFullPrompt(inserted.id)).toBe('secret full prompt');
  });

  it('lists with offset + total and hides ignore rows unless includeNonHits', async () => {
    const model = new PlatformContentModerationRecordModel(db);
    await model.insert({ ...baseInsert(), promptHash: 'a' });
    await model.insert({
      ...baseInsert(),
      effectiveAction: 'allow',
      policyAction: 'ignore',
      promptHash: 'b',
    });

    const hidden = await model.list({ limit: 20, offset: 0 });
    expect(hidden.total).toBe(1);
    expect(hidden.items).toHaveLength(1);

    const shown = await model.list({ includeNonHits: true, limit: 20, offset: 0 });
    expect(shown.total).toBe(2);
  });

  it('filters userQuery by email/username/fullName via users join', async () => {
    await db.insert(users).values({
      email: 'alice@example.com',
      fullName: 'Alice Example',
      id: 'user-alice',
      username: 'alice',
    });
    const model = new PlatformContentModerationRecordModel(db);
    await model.insert({ ...baseInsert(), userId: 'user-alice' });
    await model.insert({ ...baseInsert(), promptHash: 'other' });

    const listed = await model.list({
      limit: 20,
      offset: 0,
      userQuery: 'alice@',
    });
    expect(listed.total).toBe(1);
    expect(listed.items[0]?.userId).toBe('user-alice');
  });

  it('countUserViolations excludes cache hits and rows before the last auto-ban', async () => {
    const model = new PlatformContentModerationRecordModel(db);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await db.insert(users).values({ id: 'user-v' });

    const old = await model.insert({
      ...baseInsert(),
      autoBanned: true,
      userId: 'user-v',
    });
    await db
      .update(platformContentModerationRecords)
      .set({ createdAt: new Date(since.getTime() + 1000) })
      .where(eq(platformContentModerationRecords.id, old.id));

    await model.insert({
      ...baseInsert(),
      promptHash: 'cache',
      source: 'cache',
      userId: 'user-v',
    });
    await model.insert({
      ...baseInsert(),
      promptHash: 'fresh',
      userId: 'user-v',
    });

    const n = await model.countUserViolations({
      excludeCache: true,
      since,
      userId: 'user-v',
    });
    expect(n).toBe(1);
  });

  it('deleteByIds rejects more than 200 ids', async () => {
    const model = new PlatformContentModerationRecordModel(db);
    await expect(
      model.deleteByIds(Array.from({ length: 201 }, (_, i) => String(i))),
    ).rejects.toThrow(/CONTENT_MODERATION_DELETE_LIMIT/);
  });

  it('migration declares DESC created_at indexes as in the design', () => {
    const sql = readFileSync(
      path.join(__dirname, '../../../migrations/0016_content_moderation.sql'),
      'utf8',
    );
    expect(sql).toMatch(/"created_at" DESC/);
    expect(sql).toMatch(/"user_id", "created_at" DESC/);
  });
});
