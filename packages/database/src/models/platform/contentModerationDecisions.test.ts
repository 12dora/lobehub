// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { platformContentModerationDecisions } from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformContentModerationDecisionModel } from './contentModerationDecisions';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformContentModerationDecisions);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformContentModerationDecisionModel', () => {
  it('puts and gets an unexpired decision and bumps hit_count on upsert', async () => {
    const model = new PlatformContentModerationDecisionModel(db);
    await model.put({
      categories: { sexual: 0.9 },
      hash: 'abc',
      source: 'llm_judge',
      ttlHours: 24,
    });
    await model.put({
      categories: { sexual: 0.95 },
      hash: 'abc',
      source: 'llm_judge',
      ttlHours: 24,
    });

    const row = await model.get('abc');
    expect(row?.categories.sexual).toBe(0.95);
    expect(row?.hitCount).toBe(2);
    expect(await model.count()).toBe(1);
  });

  it('ignores expired rows on get and purgeExpired deletes them', async () => {
    const model = new PlatformContentModerationDecisionModel(db);
    await db.insert(platformContentModerationDecisions).values({
      categories: { sexual: 1 },
      expiresAt: new Date(Date.now() - 60_000),
      promptHash: 'old',
      source: 'moderations_api',
    });

    expect(await model.get('old')).toBeNull();
    expect(await model.purgeExpired()).toBe(1);
    expect(await model.count()).toBe(0);
  });

  it('clear removes every cached decision', async () => {
    const model = new PlatformContentModerationDecisionModel(db);
    await model.put({
      categories: { jailbreak: 1 },
      hash: 'one',
      source: 'llm_judge',
      ttlHours: 1,
    });
    expect(await model.clear()).toBe(1);
    expect(await model.get('one')).toBeNull();
  });
});
