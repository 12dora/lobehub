import { describe, expect, it } from 'vitest';

import {
  buildCronFromDraft,
  describeTaskTemplateSchedule,
  draftFromCron,
  formatTaskTemplateSchedule,
  formatWeekdayList,
  isValidTaskTemplateCron,
} from './schedule';

/** Echoes the key plus its interpolation so assertions stay locale-independent. */
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key;

describe('describeTaskTemplateSchedule', () => {
  it('classifies daily, weekday, weekly and multi-weekday patterns', () => {
    expect(describeTaskTemplateSchedule('0 9 * * *')).toEqual({ kind: 'daily', time: '09:00' });
    expect(describeTaskTemplateSchedule('30 9 * * 1,2,3,4,5')).toEqual({
      kind: 'weekdays',
      time: '09:30',
    });
    expect(describeTaskTemplateSchedule('0 9 * * 1')).toEqual({
      kind: 'weekly',
      time: '09:00',
      weekday: 1,
    });
    expect(describeTaskTemplateSchedule('0 18 * * 6,0')).toEqual({
      kind: 'multiWeekday',
      time: '18:00',
      weekdays: [0, 6],
    });
  });

  it('classifies hourly patterns and keeps the minute for round-trips', () => {
    expect(describeTaskTemplateSchedule('15 * * * *')).toEqual({
      interval: 1,
      kind: 'hourly',
      minute: 15,
    });
    expect(describeTaskTemplateSchedule('0 */6 * * *')).toEqual({
      interval: 6,
      kind: 'hourly',
      minute: 0,
    });
  });

  it('degrades to custom instead of guessing at unsupported shapes', () => {
    // day-of-month / month must stay '*' for the scheduled-task runtime
    expect(describeTaskTemplateSchedule('0 9 1 * *')).toEqual({
      kind: 'custom',
      pattern: '0 9 1 * *',
    });
    // several run times have no single clock value to show
    expect(describeTaskTemplateSchedule('0 9,18 * * *')).toEqual({
      kind: 'custom',
      pattern: '0 9,18 * * *',
    });
    expect(describeTaskTemplateSchedule('nonsense')).toEqual({
      kind: 'custom',
      pattern: 'nonsense',
    });
  });
});

describe('formatTaskTemplateSchedule', () => {
  it('renders one i18n key per schedule shape', () => {
    expect(formatTaskTemplateSchedule('0 9 * * *', t)).toBe(
      'taskTemplateCatalog.schedule.daily({"time":"09:00"})',
    );
    expect(formatTaskTemplateSchedule('0 9 * * 1,2,3,4,5', t)).toBe(
      'taskTemplateCatalog.schedule.weekdays({"time":"09:00"})',
    );
    expect(formatTaskTemplateSchedule('0 9 * * 1', t)).toBe(
      'taskTemplateCatalog.schedule.weekly({"time":"09:00","weekday":"taskTemplateCatalog.weekday.monday"})',
    );
    expect(formatTaskTemplateSchedule('0 * * * *', t)).toBe('taskTemplateCatalog.schedule.hourly');
    expect(formatTaskTemplateSchedule('0 */4 * * *', t)).toBe(
      'taskTemplateCatalog.schedule.hourlyEvery({"hours":4})',
    );
    expect(formatTaskTemplateSchedule('0 9 1 * *', t)).toBe(
      'taskTemplateCatalog.schedule.custom({"pattern":"0 9 1 * *"})',
    );
  });
});

describe('formatWeekdayList', () => {
  it('joins with the reader language, not a hard-coded Chinese separator', () => {
    expect(formatWeekdayList(['Sunday', 'Saturday'], 'en-US')).toBe('Sunday and Saturday');
    expect(formatWeekdayList(['周日', '周六'], 'zh-CN')).toBe('周日和周六');
    expect(formatWeekdayList(['Monday'], 'en-US')).toBe('Monday');
  });

  it('renders a multi-weekday schedule through the locale-aware list', () => {
    expect(formatTaskTemplateSchedule('0 18 * * 6,0', t, 'en-US')).toBe(
      'taskTemplateCatalog.schedule.multiWeekday({"time":"18:00","weekdays":"taskTemplateCatalog.weekday.sunday and taskTemplateCatalog.weekday.saturday"})',
    );
  });
});

describe('buildCronFromDraft / draftFromCron', () => {
  const base = {
    hour: 9,
    interval: 1,
    minute: 0,
    pattern: '',
    preset: 'daily',
    weekday: 1,
  } as const;

  it('builds a cron for every preset', () => {
    expect(buildCronFromDraft({ ...base, preset: 'daily' })).toBe('0 9 * * *');
    expect(buildCronFromDraft({ ...base, preset: 'weekdays' })).toBe('0 9 * * 1,2,3,4,5');
    expect(buildCronFromDraft({ ...base, preset: 'weekly', weekday: 3 })).toBe('0 9 * * 3');
    expect(buildCronFromDraft({ ...base, interval: 6, preset: 'hourly' })).toBe('0 */6 * * *');
    expect(buildCronFromDraft({ ...base, pattern: ' 5 7 * * 2 ', preset: 'custom' })).toBe(
      '5 7 * * 2',
    );
  });

  it('round-trips every preset it can name', () => {
    for (const pattern of ['0 9 * * *', '30 9 * * 1,2,3,4,5', '15 8 * * 3', '10 */6 * * *']) {
      expect(buildCronFromDraft(draftFromCron(pattern))).toBe(pattern);
    }
  });

  it('keeps an unnameable pattern verbatim under the custom preset', () => {
    const draft = draftFromCron('0 9,18 * * *');
    expect(draft.preset).toBe('custom');
    expect(buildCronFromDraft(draft)).toBe('0 9,18 * * *');
  });
});

describe('isValidTaskTemplateCron', () => {
  it('accepts supported patterns and rejects day/month restrictions', () => {
    expect(isValidTaskTemplateCron(' 0 9 * * * ')).toBe(true);
    expect(isValidTaskTemplateCron('0 9 1 * *')).toBe(false);
    expect(isValidTaskTemplateCron('0 9 * 3 *')).toBe(false);
    expect(isValidTaskTemplateCron('0 9 * *')).toBe(false);
  });
});
