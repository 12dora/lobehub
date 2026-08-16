import { createHash } from 'node:crypto';

import type { TaskTemplate, TaskTemplateConnector } from '@lobechat/const';
import {
  getComposioAppByIdentifier,
  getLobehubConnectorProviderById,
  INTEREST_AREA_KEYS,
  isSupportedTaskTemplateCronPattern,
  TASK_TEMPLATE_CATEGORIES,
  TASK_TEMPLATE_ICONS,
  TASK_TEMPLATE_RECOMMEND_COUNT,
  TASK_TEMPLATE_RECOMMEND_MAX_COUNT,
} from '@lobechat/const';
import { z } from 'zod';

import { appEnv } from '@/envs/app';
import { isTrustedClientEnabled } from '@/libs/trusted-client';
import { MarketService } from '@/server/services/market';

const clampRecommendationCount = (count?: number) =>
  Math.min(Math.max(1, count ?? TASK_TEMPLATE_RECOMMEND_COUNT), TASK_TEMPLATE_RECOMMEND_MAX_COUNT);

const getInstanceSeedScope = () =>
  process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_PRODUCTION_URL || appEnv.APP_URL;

export const createTaskTemplateRecommendationSeedKey = (
  userId: string,
  instanceSeedScope = getInstanceSeedScope(),
) =>
  createHash('sha256')
    .update(`task-template-recommendation:v1:${instanceSeedScope}:${userId}`)
    .digest('base64url');

const taskTemplateConnectorSchema: z.ZodType<TaskTemplateConnector> = z
  .object({
    identifier: z.string(),
    required: z.boolean(),
    source: z.enum(['composio', 'lobehub']),
  })
  .refine(
    (connector) =>
      connector.source === 'lobehub'
        ? !!getLobehubConnectorProviderById(connector.identifier)
        : !!getComposioAppByIdentifier(connector.identifier),
    { message: 'Unknown task template connector' },
  );

const taskTemplateSchema: z.ZodType<TaskTemplate> = z.object({
  category: z.enum(TASK_TEMPLATE_CATEGORIES),
  connectors: z.array(taskTemplateConnectorSchema),
  cronPattern: z.string().refine(isSupportedTaskTemplateCronPattern, {
    message: 'Unsupported task template cron pattern',
  }),
  description: z.string(),
  icon: z.enum(TASK_TEMPLATE_ICONS).optional(),
  id: z.number().int(),
  identifier: z.string(),
  instruction: z.string(),
  interests: z.array(z.enum(INTEREST_AREA_KEYS)),
  title: z.string(),
});

const taskTemplateRecommendationEnvelopeSchema = z.object({
  items: z.array(z.unknown()),
});

const parseTaskTemplateRecommendations = (value: unknown): TaskTemplate[] => {
  const envelope = taskTemplateRecommendationEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new Error('Market recommendations returned no items array');
  }

  const items = z.array(taskTemplateSchema).safeParse(envelope.data.items);
  if (!items.success) {
    throw new Error('Market recommendations returned malformed items');
  }

  return items.data;
};

export interface TaskTemplateRecommendationOptions {
  count?: number;
  excludeIds?: number[];
  locale?: string;
  refreshSeed?: string;
  /** Bounded abort signal for callers (e.g. admin import) that must not hang on a stalled market. */
  signal?: AbortSignal;
}

/** Thrown when the outbound market request exceeded the caller's bounded deadline. */
export class TaskTemplateMarketTimeoutError extends Error {
  readonly code = 'TASK_TEMPLATE_MARKET_TIMEOUT' as const;

  constructor(message = 'Market recommendations request timed out') {
    super(message);
    this.name = 'TaskTemplateMarketTimeoutError';
  }
}

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');

export class TaskTemplateService {
  private marketService: MarketService;

  constructor(private userId: string) {
    this.marketService = new MarketService({ userInfo: { userId } });
  }

  private async requestRecommendations(
    interestKeys: string[],
    options: TaskTemplateRecommendationOptions,
  ): Promise<unknown> {
    const params = {
      count: clampRecommendationCount(options.count),
      excludeIds: options.excludeIds,
      interestKeys,
      locale: options.locale,
      refreshSeed: options.refreshSeed,
      ...(isTrustedClientEnabled()
        ? {}
        : { seedKey: createTaskTemplateRecommendationSeedKey(this.userId) }),
    };
    const recommendations = this.marketService.market.taskTemplates;

    try {
      // Only pass request options when there is something to say — the user-facing read keeps
      // its single-argument call shape.
      return options.signal
        ? await recommendations.getTaskTemplateRecommendations(params, {
            signal: options.signal,
          })
        : await recommendations.getTaskTemplateRecommendations(params);
    } catch (error) {
      if (isAbortError(error)) throw new TaskTemplateMarketTimeoutError();
      throw error;
    }
  }

  async listDailyRecommend(
    interestKeys: string[],
    options: TaskTemplateRecommendationOptions = {},
  ): Promise<TaskTemplate[]> {
    try {
      return parseTaskTemplateRecommendations(
        await this.requestRecommendations(interestKeys, options),
      );
    } catch (error) {
      console.error('[taskTemplate:listDailyRecommend] Market recommendations failed', error);
      throw error;
    }
  }

  /**
   * Recommendation items **without** whole-array validation.
   *
   * `listDailyRecommend` rejects the entire response when a single row is malformed, which is the
   * right behaviour for a user-facing render. The admin import instead validates row by row so one
   * bad upstream row is skipped rather than failing the whole import.
   */
  async listDailyRecommendRaw(
    interestKeys: string[],
    options: TaskTemplateRecommendationOptions = {},
  ): Promise<unknown[]> {
    const envelope = taskTemplateRecommendationEnvelopeSchema.safeParse(
      await this.requestRecommendations(interestKeys, options),
    );
    if (!envelope.success) {
      throw new Error('Market recommendations returned no items array');
    }
    return envelope.data.items;
  }
}
