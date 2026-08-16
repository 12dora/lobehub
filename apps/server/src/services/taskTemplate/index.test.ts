// @vitest-environment node
import {
  INTEREST_AREA_KEYS,
  isSupportedTaskTemplateCronPattern,
  TASK_TEMPLATE_CATEGORIES,
  TASK_TEMPLATE_PERSONAL_ONLY_CATEGORIES,
  TASK_TEMPLATE_RECOMMEND_COUNT,
  TASK_TEMPLATE_RECOMMEND_MAX_COUNT,
} from '@lobechat/const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTaskTemplateRecommendationSeedKey,
  listTaskTemplateLibrary,
  resolveTaskTemplateLibraryLocale,
  TASK_TEMPLATE_LIBRARY,
  TaskTemplateService,
} from './index';

const { mockAppEnv } = vi.hoisted(() => ({
  mockAppEnv: { APP_URL: 'https://self-hosted.example' },
}));

vi.mock('@/envs/app', () => ({ appEnv: mockAppEnv }));

const fixedNow = () => new Date('2026-08-17T08:00:00.000Z');

describe('bundled task-template library', () => {
  it('only ships work templates — no personal-only categories, no connectors required', () => {
    expect(TASK_TEMPLATE_LIBRARY.length).toBeGreaterThanOrEqual(24);
    for (const item of TASK_TEMPLATE_LIBRARY) {
      expect(TASK_TEMPLATE_PERSONAL_ONLY_CATEGORIES).not.toContain(item.category);
      expect(TASK_TEMPLATE_CATEGORIES).toContain(item.category);
      expect(item.connectors).toEqual([]);
      expect(isSupportedTaskTemplateCronPattern(item.cronPattern)).toBe(true);
      expect(item.interests.length).toBeGreaterThan(0);
      for (const interest of item.interests) expect(INTEREST_AREA_KEYS).toContain(interest);
      expect(item.identifier).toMatch(/^[a-z0-9-]+$/);
      for (const locale of ['zh-CN', 'en-US'] as const) {
        expect(item.text[locale].title.trim()).not.toBe('');
        expect(item.text[locale].description.trim()).not.toBe('');
        expect(item.text[locale].instruction.trim()).not.toBe('');
      }
    }
  });

  it('has unique identifiers and ids', () => {
    expect(new Set(TASK_TEMPLATE_LIBRARY.map((item) => item.identifier)).size).toBe(
      TASK_TEMPLATE_LIBRARY.length,
    );
    expect(new Set(TASK_TEMPLATE_LIBRARY.map((item) => item.id)).size).toBe(
      TASK_TEMPLATE_LIBRARY.length,
    );
  });

  it('covers the core enterprise functions', () => {
    const categories = new Set(TASK_TEMPLATE_LIBRARY.map((item) => item.category));
    for (const category of [
      'engineering',
      'operations',
      'sales-customer',
      'business',
      'marketing',
      'product',
      'hr',
      'finance-legal',
    ]) {
      expect(categories.has(category as never)).toBe(true);
    }
  });

  it('resolves zh locales to zh-CN and everything else to en-US', () => {
    expect(resolveTaskTemplateLibraryLocale('zh-CN')).toBe('zh-CN');
    expect(resolveTaskTemplateLibraryLocale('zh')).toBe('zh-CN');
    expect(resolveTaskTemplateLibraryLocale('zh-TW')).toBe('zh-CN');
    expect(resolveTaskTemplateLibraryLocale('en-US')).toBe('en-US');
    expect(resolveTaskTemplateLibraryLocale('ja-JP')).toBe('en-US');
    expect(resolveTaskTemplateLibraryLocale(undefined)).toBe('en-US');

    const zh = listTaskTemplateLibrary('zh-CN');
    const en = listTaskTemplateLibrary('en-US');
    expect(zh[0]!.title).not.toBe(en[0]!.title);
    expect(zh[0]!.identifier).toBe(en[0]!.identifier);
  });
});

describe('TaskTemplateService.listDailyRecommend', () => {
  beforeEach(() => {
    mockAppEnv.APP_URL = 'https://self-hosted.example';
  });

  it('returns the default count of localized library templates', async () => {
    const service = new TaskTemplateService('user-1', fixedNow);
    const result = await service.listDailyRecommend(['coding'], { locale: 'zh-CN' });

    expect(result).toHaveLength(TASK_TEMPLATE_RECOMMEND_COUNT);
    for (const item of result) {
      expect(TASK_TEMPLATE_LIBRARY.some((lib) => lib.identifier === item.identifier)).toBe(true);
      expect(item.connectors).toEqual([]);
    }
  });

  it('prefers templates matching the interests, then fills from the rest', async () => {
    const service = new TaskTemplateService('user-1', fixedNow);
    const hrCount = TASK_TEMPLATE_LIBRARY.filter((item) => item.interests.includes('hr')).length;
    const result = await service.listDailyRecommend(['hr'], { count: hrCount + 2 });

    expect(result.slice(0, hrCount).every((item) => item.interests.includes('hr'))).toBe(true);
    expect(result.slice(hrCount).every((item) => !item.interests.includes('hr'))).toBe(true);
  });

  it('is deterministic per user/day and changes with the refresh seed', async () => {
    const service = new TaskTemplateService('user-1', fixedNow);
    const a = await service.listDailyRecommend([], { count: 5 });
    const b = await service.listDailyRecommend([], { count: 5 });
    const c = await service.listDailyRecommend([], { count: 5, refreshSeed: 'again' });

    expect(a.map((item) => item.identifier)).toEqual(b.map((item) => item.identifier));
    expect(c.map((item) => item.identifier)).not.toEqual(a.map((item) => item.identifier));
  });

  it('honours excludeIds and clamps oversized counts', async () => {
    const service = new TaskTemplateService('user-1', fixedNow);
    const first = await service.listDailyRecommend([], { count: 1 });
    const excludedId = Number(first[0]!.id);

    const rest = await service.listDailyRecommend([], { count: 999, excludeIds: [excludedId] });
    expect(rest).toHaveLength(TASK_TEMPLATE_RECOMMEND_MAX_COUNT);
    expect(rest.some((item) => Number(item.id) === excludedId)).toBe(false);
  });
});

describe('TaskTemplateService.listDailyRecommendRaw', () => {
  it('returns the whole localized library for the admin import', async () => {
    const service = new TaskTemplateService('user-1', fixedNow);
    const items = await service.listDailyRecommendRaw([...INTEREST_AREA_KEYS], {
      locale: 'en-US',
    });
    expect(items).toHaveLength(TASK_TEMPLATE_LIBRARY.length);
    expect((items[0] as { title: string }).title).toBe(
      TASK_TEMPLATE_LIBRARY[0]!.text['en-US'].title,
    );
  });
});

describe('createTaskTemplateRecommendationSeedKey', () => {
  it('is stable for the same user and instance and does not expose the user id', () => {
    const key = createTaskTemplateRecommendationSeedKey('user-1');
    expect(key).toBe(createTaskTemplateRecommendationSeedKey('user-1'));
    expect(key).not.toContain('user-1');
    expect(key).not.toBe(createTaskTemplateRecommendationSeedKey('user-2'));
    expect(key).not.toBe(createTaskTemplateRecommendationSeedKey('user-1', 'other-instance'));
  });
});
