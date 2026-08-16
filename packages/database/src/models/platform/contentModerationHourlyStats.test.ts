// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MODERATION_DEFAULT_CATEGORY_POLICY } from '@/const/platform/contentModeration';

import { getTestDB } from '../../core/getTestDB';
import {
  platformContentModerationHourlyStats,
  platformContentModerationRecords,
} from '../../schemas/platform';
import type { LobeChatDatabase } from '../../type';
import { PlatformContentModerationHourlyStatsModel } from './contentModerationHourlyStats';
import { PlatformContentModerationRecordModel } from './contentModerationRecords';

const db: LobeChatDatabase = await getTestDB();

const cleanup = async () => {
  await db.delete(platformContentModerationHourlyStats);
  await db.delete(platformContentModerationRecords);
};

beforeEach(cleanup);
afterEach(cleanup);

describe('PlatformContentModerationHourlyStatsModel', () => {
  it('increments on conflict and reports totals / series', async () => {
    const model = new PlatformContentModerationHourlyStatsModel(db);
    const bucketStart = new Date('2026-08-01T10:00:00.000Z');
    await model.increment({
      bucketStart,
      effectiveAction: 'block',
      latencyMs: 40,
      policyAction: 'block',
      requestKind: 'chat',
      source: 'keyword',
      topCategory: 'sexual',
    });
    await model.increment({
      bucketStart,
      effectiveAction: 'block',
      latencyMs: 60,
      policyAction: 'block',
      requestKind: 'chat',
      source: 'keyword',
      topCategory: 'sexual',
    });

    const totals = await model.totals({
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(totals.block).toBe(2);
    expect(totals.total).toBe(2);
    expect(totals.avgLatencyMs).toBe(50);
    expect(totals.wouldBlock).toBe(2);

    const series = await model.series({
      bucket: 'day',
      from: new Date('2026-08-01T00:00:00.000Z'),
      timezone: 'UTC',
      to: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(series.some((point) => point.block === 2)).toBe(true);
  });

  it('classifierHealth uses the last N classifier/error records', async () => {
    const records = new PlatformContentModerationRecordModel(db);
    const stats = new PlatformContentModerationHourlyStatsModel(db);
    await records.insert({
      categoryScores: { sexual: 0.1 },
      classifierLatencyMs: 100,
      effectiveAction: 'allow',
      model: 'm',
      policyAction: 'ignore',
      promptExcerpt: 'a',
      promptHash: 'h1',
      provider: 'p',
      requestKind: 'chat',
      source: 'llm_judge',
      thresholdSnapshot: MODERATION_DEFAULT_CATEGORY_POLICY,
    });
    await records.insert({
      categoryScores: {},
      classifierLatencyMs: 200,
      effectiveAction: 'error',
      error: 'timeout',
      model: 'm',
      policyAction: 'ignore',
      promptExcerpt: 'b',
      promptHash: 'h2',
      provider: 'p',
      requestKind: 'chat',
      source: 'none',
      thresholdSnapshot: MODERATION_DEFAULT_CATEGORY_POLICY,
    });

    const health = await stats.classifierHealth({ lastN: 100 });
    expect(health?.sampleSize).toBe(2);
    expect(health?.successRate).toBe(0.5);
    expect(health?.avgLatencyMs).toBe(150);
  });
});
