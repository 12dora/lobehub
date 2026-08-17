import { eq } from 'drizzle-orm';

import { PlatformContentModerationDecisionModel } from '@/database/models/platform/contentModerationDecisions';
import { PlatformContentModerationHourlyStatsModel } from '@/database/models/platform/contentModerationHourlyStats';
import { PlatformContentModerationRecordModel } from '@/database/models/platform/contentModerationRecords';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';
import type { EmailService } from '@/server/services/email';

import { AdminUserLifecycleService } from '../adminUser/lifecycleService';
import {
  AUTO_BAN_REASON_CODE,
  MODERATION_NOTIFY_THROTTLE_MS,
  MODERATION_PURGE_INTERVAL_MS,
} from './constants';
import type { EvaluatedDecision, EvaluatePromptInput } from './decisionService';
import { buildExcerpt, redactSensitive } from './redact';
import type { ModerationSnapshot } from './settingsSnapshot';
import { getUserPlatformRoleNames } from './userRoles';

export interface RecordDecisionContext extends EvaluatePromptInput {
  config: ModerationSnapshot['config'];
  emailService?: EmailService;
  now?: () => number;
  recordId?: string;
}

const notifyThrottle = new Map<string, number>();
let lastPurgeAt = 0;

const hourBucket = (at: Date): Date => {
  const bucket = new Date(at);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
};

export const resetRecorderStateForTest = () => {
  notifyThrottle.clear();
  lastPurgeAt = 0;
};

const persistHourly = async (
  db: LobeChatDatabase,
  ctx: RecordDecisionContext,
  decision: EvaluatedDecision,
) => {
  await new PlatformContentModerationHourlyStatsModel(db).increment({
    bucketStart: hourBucket(new Date(ctx.now?.() ?? Date.now())),
    effectiveAction: decision.effectiveAction,
    latencyMs: decision.latencyMs,
    policyAction: decision.policyAction,
    requestKind: ctx.requestKind,
    source: decision.source,
    topCategory: decision.topCategory,
  });
};

const loadUserSnapshot = async (db: LobeChatDatabase, userId: string) => {
  const [row] = await db
    .select({
      email: users.email,
      fullName: users.fullName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? { email: null, fullName: null, username: null };
};

const maybeAutoBan = async (
  db: LobeChatDatabase,
  ctx: RecordDecisionContext,
  decision: EvaluatedDecision,
  recordId: string,
): Promise<boolean> => {
  const { autoBan } = ctx.config;
  if (!autoBan.enabled) return false;
  if (decision.error) return false;
  if (!['downgrade', 'block'].includes(decision.effectiveAction)) return false;

  const roles = await getUserPlatformRoleNames(db, ctx.userId);
  if (roles.includes('super_admin')) return false;
  const exempt = new Set(ctx.config.scope.exemptRoles);
  if (roles.some((role) => exempt.has(role))) return false;
  if (ctx.config.scope.exemptUserIds.includes(ctx.userId)) return false;

  const since = new Date(Date.now() - autoBan.windowDays * 24 * 60 * 60 * 1000);
  const records = new PlatformContentModerationRecordModel(db);
  const violations = await records.countUserViolations({
    excludeCache: true,
    since,
    userId: ctx.userId,
  });
  if (violations < autoBan.threshold) return false;

  const expiresAt =
    autoBan.durationDays === null
      ? null
      : new Date(Date.now() + autoBan.durationDays * 24 * 60 * 60 * 1000);

  await new AdminUserLifecycleService(db).systemBan({
    input: {
      expiresAt: expiresAt ?? undefined,
      reason: `${AUTO_BAN_REASON_CODE}:${violations}`,
      userId: ctx.userId,
    },
    recordId,
  });

  return true;
};

const maybeNotify = async (
  db: LobeChatDatabase,
  ctx: RecordDecisionContext,
  decision: EvaluatedDecision,
  recordId: string,
) => {
  const { notify } = ctx.config;
  if (!notify.enabled || notify.emails.length === 0) return;
  if (!notify.onActions.includes(decision.effectiveAction)) return;
  if (!ctx.emailService) return;

  const now = ctx.now?.() ?? Date.now();
  const last = notifyThrottle.get(ctx.userId) ?? 0;
  if (now - last < MODERATION_NOTIFY_THROTTLE_MS) return;
  notifyThrottle.set(ctx.userId, now);

  try {
    await ctx.emailService.sendBrandedMail((branding) => ({
      subject: `[${branding.branding.name}] Content moderation ${decision.effectiveAction}`,
      text: `User ${ctx.userId} triggered ${decision.effectiveAction} (${decision.topCategory ?? 'n/a'}). Record ${recordId}.`,
      to: notify.emails.join(','),
    }));
    await new PlatformContentModerationRecordModel(db).markNotified(recordId);
  } catch (error) {
    console.error('[content-moderation] notify failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};

const maybePurge = async (db: LobeChatDatabase, ctx: RecordDecisionContext) => {
  const now = ctx.now?.() ?? Date.now();
  if (now - lastPurgeAt < MODERATION_PURGE_INTERVAL_MS) return;
  lastPurgeAt = now;
  try {
    await new PlatformContentModerationRecordModel(db).purgeExpired({
      hitRetentionDays: ctx.config.records.hitRetentionDays,
      limit: 5000,
      nonHitRetentionDays: ctx.config.records.nonHitRetentionDays,
    });
    await new PlatformContentModerationHourlyStatsModel(db).purgeOlderThan(400);
    await new PlatformContentModerationDecisionModel(db).purgeExpired();
  } catch (error) {
    console.error('[content-moderation] retention purge failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  }
};

/**
 * Persist a decision. Callers should fire-and-forget:
 * `void recordDecision(db, ctx, decision).catch(log)`.
 *
 * Persistence errors never throw to the user path — they are logged.
 *
 * How B3 routers obtain {@link EmailService}:
 * `import { EmailService } from '@/server/services/email'; new EmailService()`
 */
export const recordDecision = async (
  db: LobeChatDatabase,
  ctx: RecordDecisionContext,
  decision: EvaluatedDecision,
): Promise<string | null> => {
  try {
    await persistHourly(db, ctx, decision);

    const skipRow =
      decision.policyAction === 'ignore' &&
      decision.effectiveAction === 'allow' &&
      !ctx.config.records.recordNonHits;

    if (skipRow) {
      void maybePurge(db, ctx);
      return null;
    }

    const snapshot = await loadUserSnapshot(db, ctx.userId);
    const since = new Date(Date.now() - ctx.config.autoBan.windowDays * 24 * 60 * 60 * 1000);
    const violationCount = ['downgrade', 'block'].includes(decision.effectiveAction)
      ? (await new PlatformContentModerationRecordModel(db).countUserViolations({
          excludeCache: true,
          since,
          userId: ctx.userId,
        })) + 1
      : 0;

    const inserted = await new PlatformContentModerationRecordModel(db).insert({
      categoryScores: decision.scores,
      classifierLatencyMs: decision.latencyMs,
      effectiveAction: decision.effectiveAction,
      effectiveModel: decision.downgradeTarget?.model ?? null,
      effectiveProvider: decision.downgradeTarget?.provider ?? null,
      enforced: decision.enforce,
      error: decision.error ?? null,
      id: ctx.recordId,
      matchedRule: decision.matchedRule
        ? {
            id: decision.matchedRule.id,
            isRegex: decision.matchedRule.isRegex,
            pattern: decision.matchedRule.pattern,
          }
        : null,
      messageId: ctx.messageId ?? null,
      model: ctx.model,
      policyAction: decision.policyAction,
      promptExcerpt: buildExcerpt(ctx.text),
      promptFull: ctx.config.records.storeFullPrompt ? redactSensitive(ctx.text) : null,
      promptHash: decision.hash,
      provider: ctx.provider,
      requestId: ctx.requestId ?? null,
      requestKind: ctx.requestKind,
      source: decision.source,
      thresholdSnapshot: decision.thresholdSnapshot,
      topCategory: decision.topCategory,
      topScore: decision.topScore,
      topicId: ctx.topicId ?? null,
      userId: ctx.userId,
      userSnapshot: snapshot,
      violationCount,
    });

    if (
      (decision.source === 'llm_judge' || decision.source === 'moderations_api') &&
      decision.policyAction !== 'ignore' &&
      ctx.config.decisionCache.enabled &&
      ctx.config.decisionCache.ttlHours > 0
    ) {
      await new PlatformContentModerationDecisionModel(db).put({
        categories: decision.scores,
        hash: decision.hash,
        source: decision.source,
        ttlHours: ctx.config.decisionCache.ttlHours,
      });
    }

    if (['downgrade', 'block'].includes(decision.effectiveAction)) {
      await maybeAutoBan(db, ctx, decision, inserted.id);
    }

    await maybeNotify(db, ctx, decision, inserted.id);
    void maybePurge(db, ctx);
    return inserted.id;
  } catch (error) {
    console.error('[content-moderation] recordDecision failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    return null;
  }
};

/**
 * Fire-and-forget wrapper. Persistence / notify / ban failures are logged.
 */
export const recordDecisionAsync = (
  db: LobeChatDatabase,
  ctx: RecordDecisionContext,
  decision: EvaluatedDecision,
): void => {
  void recordDecision(db, ctx, decision).catch((error: unknown) => {
    console.error('[content-moderation] recordDecision async failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
  });
};
