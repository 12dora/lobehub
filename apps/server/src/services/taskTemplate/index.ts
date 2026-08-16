import { createHash } from 'node:crypto';

import type { TaskTemplate } from '@lobechat/const';
import { TASK_TEMPLATE_RECOMMEND_COUNT, TASK_TEMPLATE_RECOMMEND_MAX_COUNT } from '@lobechat/const';

import { appEnv } from '@/envs/app';

import { listTaskTemplateLibrary } from './library';

export {
  listTaskTemplateLibrary,
  resolveTaskTemplateLibraryLocale,
  TASK_TEMPLATE_LIBRARY,
} from './library';

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

export interface TaskTemplateRecommendationOptions {
  count?: number;
  excludeIds?: number[];
  locale?: string;
  refreshSeed?: string;
  /** Kept for call-site compatibility; the bundled library never performs I/O. */
  signal?: AbortSignal;
}

const rankKey = (seed: string, identifier: string) =>
  createHash('sha256').update(`${seed}:${identifier}`).digest('hex');

/** UTC calendar day — the daily slice rotates once a day, per user, per instance. */
const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Task-template recommendations served from the bundled, work-only library
 * (see `./library.ts`). No outbound market call is made.
 */
export class TaskTemplateService {
  constructor(
    private userId: string,
    private now: () => Date = () => new Date(),
  ) {}

  /**
   * A daily slice for the home page: templates matching the user's interests first, the rest of
   * the library as filler, deterministically rotated by (user, instance, day, refreshSeed).
   */
  async listDailyRecommend(
    interestKeys: string[],
    options: TaskTemplateRecommendationOptions = {},
  ): Promise<TaskTemplate[]> {
    const count = clampRecommendationCount(options.count);
    const excluded = new Set(options.excludeIds ?? []);
    const interests = new Set(interestKeys);
    const seed = `${createTaskTemplateRecommendationSeedKey(this.userId)}:${utcDay(this.now())}:${
      options.refreshSeed ?? ''
    }`;

    const library = listTaskTemplateLibrary(options.locale).filter(
      (item) => !excluded.has(Number(item.id)),
    );
    const byRank = (a: TaskTemplate, b: TaskTemplate) =>
      rankKey(seed, a.identifier).localeCompare(rankKey(seed, b.identifier));

    const matched = library
      .filter((item) => item.interests.some((interest) => interests.has(interest)))
      .sort(byRank);
    const filler = library.filter((item) => !matched.includes(item)).sort(byRank);

    return [...matched, ...filler].slice(0, count);
  }

  /**
   * The full library for the admin import. Named for compatibility with the previous market-backed
   * implementation; the admin router still validates row by row.
   */
  async listDailyRecommendRaw(
    _interestKeys: string[],
    options: TaskTemplateRecommendationOptions = {},
  ): Promise<unknown[]> {
    return listTaskTemplateLibrary(options.locale);
  }
}
