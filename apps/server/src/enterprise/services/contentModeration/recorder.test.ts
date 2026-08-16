import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import type { EvaluatedDecision } from './decisionService';
import { emptyCategoryScores } from './policy';
import { recordDecision, resetRecorderStateForTest } from './recorder';

const increment = vi.fn(async () => undefined);
const insert = vi.fn(async (record: { id?: string }) => ({ id: record.id ?? 'rec-1' }));
const countUserViolations = vi.fn(async () => 0);
const put = vi.fn(async () => undefined);
const systemBan = vi.fn(async () => ({ banned: true }));
const markNotified = vi.fn(async () => undefined);
const getRoles = vi.fn(async () => ['member']);

vi.mock('@/database/models/platform/contentModerationHourlyStats', () => ({
  PlatformContentModerationHourlyStatsModel: class {
    increment = increment;
    purgeOlderThan = vi.fn();
  },
}));

vi.mock('@/database/models/platform/contentModerationRecords', () => ({
  PlatformContentModerationRecordModel: class {
    insert = insert;
    countUserViolations = countUserViolations;
    markNotified = markNotified;
    purgeExpired = vi.fn();
  },
}));

vi.mock('@/database/models/platform/contentModerationDecisions', () => ({
  PlatformContentModerationDecisionModel: class {
    put = put;
    purgeExpired = vi.fn();
  },
}));

vi.mock('../adminUser/lifecycleService', () => ({
  AdminUserLifecycleService: class {
    systemBan = systemBan;
  },
}));

vi.mock('./userRoles', () => ({
  getUserPlatformRoleNames: () => getRoles(),
}));

const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => [{ email: 'a@b.c', fullName: 'A', username: 'a' }],
      }),
    }),
  }),
} as never;

const decision = (overrides: Partial<EvaluatedDecision> = {}): EvaluatedDecision => ({
  effectiveAction: 'block',
  enforce: false,
  hash: 'abc',
  latencyMs: 10,
  policyAction: 'block',
  recordId: 'rec-test',
  reused: false,
  scores: { ...emptyCategoryScores(), sexual: 1 },
  skipped: false,
  source: 'keyword',
  thresholdSnapshot: createDefaultContentModerationConfig().categories,
  topCategory: 'sexual',
  topScore: 1,
  ...overrides,
});

const ctx = (overrides: Record<string, unknown> = {}) => ({
  config: createDefaultContentModerationConfig(),
  model: 'gpt-4o',
  provider: 'openai',
  requestKind: 'chat' as const,
  text: 'hello',
  userId: 'user-1',
  ...overrides,
});

beforeEach(() => {
  increment.mockClear();
  insert.mockClear();
  countUserViolations.mockClear();
  put.mockClear();
  systemBan.mockClear();
  getRoles.mockClear();
  resetRecorderStateForTest();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('recordDecision', () => {
  it('skips the record row for non-hits but still increments hourly stats', async () => {
    const id = await recordDecision(
      db,
      ctx(),
      decision({ effectiveAction: 'allow', policyAction: 'ignore', source: 'none' }),
    );
    expect(id).toBeNull();
    expect(increment).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts a hit record and writes the decision cache for a classifier source', async () => {
    await recordDecision(db, ctx(), decision({ source: 'llm_judge', policyAction: 'block' }));
    expect(insert).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it('auto-bans when the windowed violation count reaches the threshold', async () => {
    const config = createDefaultContentModerationConfig();
    config.autoBan.enabled = true;
    config.autoBan.threshold = 2;
    countUserViolations.mockResolvedValue(2);
    await recordDecision(db, ctx({ config }), decision());
    expect(systemBan).toHaveBeenCalledTimes(1);
  });

  it('never auto-bans a user who holds super_admin', async () => {
    const config = createDefaultContentModerationConfig();
    config.autoBan.enabled = true;
    config.autoBan.threshold = 1;
    config.scope.exemptRoles = [];
    countUserViolations.mockResolvedValue(10);
    getRoles.mockResolvedValueOnce(['super_admin']);
    await recordDecision(db, ctx({ config }), decision());
    expect(systemBan).not.toHaveBeenCalled();
  });

  it('throttles notify to once per user per hour', async () => {
    const config = createDefaultContentModerationConfig();
    config.notify.enabled = true;
    config.notify.emails = ['ops@example.com'];
    const sendBrandedMail = vi.fn(async () => ({ messageId: 'm' }));
    const now = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000);
    await recordDecision(db, ctx({ config, emailService: { sendBrandedMail }, now }), decision());
    await recordDecision(db, ctx({ config, emailService: { sendBrandedMail }, now }), decision());
    expect(sendBrandedMail).toHaveBeenCalledTimes(1);
  });
});
