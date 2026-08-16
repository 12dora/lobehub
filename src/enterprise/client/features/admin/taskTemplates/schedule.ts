import { isSupportedTaskTemplateCronPattern } from '@lobechat/const';

/** Weekday numbers as they appear in a cron pattern (0 = Sunday). */
export const TASK_TEMPLATE_WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export type TaskTemplateSchedulePreset = 'custom' | 'daily' | 'hourly' | 'weekdays' | 'weekly';

export type TaskTemplateScheduleSummary =
  | { kind: 'custom'; pattern: string }
  | { kind: 'daily'; time: string }
  | { kind: 'hourly'; interval: number; minute: number }
  | { kind: 'multiWeekday'; time: string; weekdays: number[] }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; time: string; weekday: number };

const pad = (value: number) => String(value).padStart(2, '0');

export const formatClockTime = (hour: number, minute: number): string =>
  `${pad(hour)}:${pad(minute)}`;

const parseWeekdays = (field: string): number[] | null => {
  if (field === '*') return null;
  const values = field
    .split(',')
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : null;
};

const WEEKDAY_WORKWEEK = [1, 2, 3, 4, 5];

/**
 * Classify a task-template cron into the shapes the console can name in plain language.
 * Anything the scheduled-task runtime does not support (or that this vocabulary cannot
 * describe) degrades to `custom`, which renders the raw pattern rather than lying about it.
 */
export const describeTaskTemplateSchedule = (cronPattern: string): TaskTemplateScheduleSummary => {
  const pattern = cronPattern.trim();
  if (!isSupportedTaskTemplateCronPattern(pattern)) return { kind: 'custom', pattern };

  const [minuteField, hourField, , , weekdayField] = pattern.split(/\s+/);

  // Hourly shapes: `m */N * * *` and `m * * * *`.
  if (hourField === '*' || hourField.startsWith('*/')) {
    if (weekdayField !== '*') return { kind: 'custom', pattern };
    if (minuteField.includes(',') || minuteField.includes('/') || minuteField === '*') {
      return { kind: 'custom', pattern };
    }
    const interval = hourField === '*' ? 1 : Number.parseInt(hourField.slice(2), 10);
    return { interval, kind: 'hourly', minute: Number.parseInt(minuteField, 10) };
  }

  // A list of minutes or hours has no single "time" to display.
  if (minuteField.includes(',') || minuteField.includes('/') || minuteField === '*') {
    return { kind: 'custom', pattern };
  }
  if (hourField.includes(',')) return { kind: 'custom', pattern };

  const time = formatClockTime(Number.parseInt(hourField, 10), Number.parseInt(minuteField, 10));
  const weekdays = parseWeekdays(weekdayField);

  if (!weekdays) return { kind: 'daily', time };
  if (
    weekdays.length === WEEKDAY_WORKWEEK.length &&
    weekdays.every((value, index) => value === WEEKDAY_WORKWEEK[index])
  ) {
    return { kind: 'weekdays', time };
  }
  if (weekdays.length === 1) return { kind: 'weekly', time, weekday: weekdays[0]! };
  return { kind: 'multiWeekday', time, weekdays };
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Join weekday labels the way the reader's language does ("Sunday and Saturday" / "周日、周六").
 * Falls back to a comma join on runtimes without `Intl.ListFormat`.
 */
export const formatWeekdayList = (labels: string[], locale?: string): string => {
  if (labels.length < 2) return labels.join('');
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(labels);
  } catch {
    return labels.join(', ');
  }
};

/** Human-readable schedule line for the admin table and the editor preview. */
export const formatTaskTemplateSchedule = (
  cronPattern: string,
  t: Translate,
  locale?: string,
): string => {
  const summary = describeTaskTemplateSchedule(cronPattern);
  const weekdayLabel = (index: number) =>
    t(`taskTemplateCatalog.weekday.${TASK_TEMPLATE_WEEKDAY_KEYS[index]}`);

  switch (summary.kind) {
    case 'daily': {
      return t('taskTemplateCatalog.schedule.daily', { time: summary.time });
    }
    case 'weekdays': {
      return t('taskTemplateCatalog.schedule.weekdays', { time: summary.time });
    }
    case 'weekly': {
      return t('taskTemplateCatalog.schedule.weekly', {
        time: summary.time,
        weekday: weekdayLabel(summary.weekday),
      });
    }
    case 'multiWeekday': {
      return t('taskTemplateCatalog.schedule.multiWeekday', {
        time: summary.time,
        weekdays: formatWeekdayList(
          summary.weekdays.map((index) => weekdayLabel(index)),
          locale,
        ),
      });
    }
    case 'hourly': {
      return summary.interval === 1
        ? t('taskTemplateCatalog.schedule.hourly')
        : t('taskTemplateCatalog.schedule.hourlyEvery', { hours: summary.interval });
    }
    default: {
      return t('taskTemplateCatalog.schedule.custom', { pattern: summary.pattern });
    }
  }
};

export interface TaskTemplateScheduleDraft {
  hour: number;
  /** Only used by the `hourly` preset. */
  interval: number;
  minute: number;
  pattern: string;
  preset: TaskTemplateSchedulePreset;
  /** Only used by the `weekly` preset. */
  weekday: number;
}

/** Build the cron pattern a preset-driven editor state represents. */
export const buildCronFromDraft = (draft: TaskTemplateScheduleDraft): string => {
  switch (draft.preset) {
    case 'daily': {
      return `${draft.minute} ${draft.hour} * * *`;
    }
    case 'weekdays': {
      return `${draft.minute} ${draft.hour} * * ${WEEKDAY_WORKWEEK.join(',')}`;
    }
    case 'weekly': {
      return `${draft.minute} ${draft.hour} * * ${draft.weekday}`;
    }
    case 'hourly': {
      return `${draft.minute} */${draft.interval} * * *`;
    }
    default: {
      return draft.pattern.trim();
    }
  }
};

/** Seed the editor state from an existing cron pattern (edit / round-trip). */
export const draftFromCron = (cronPattern: string): TaskTemplateScheduleDraft => {
  const summary = describeTaskTemplateSchedule(cronPattern);
  const base: TaskTemplateScheduleDraft = {
    hour: 9,
    interval: 1,
    minute: 0,
    pattern: cronPattern.trim(),
    preset: 'custom',
    weekday: 1,
  };
  const [hourOf, minuteOf] = [
    (time: string) => Number.parseInt(time.slice(0, 2), 10),
    (time: string) => Number.parseInt(time.slice(3, 5), 10),
  ];

  switch (summary.kind) {
    case 'daily': {
      return {
        ...base,
        hour: hourOf(summary.time),
        minute: minuteOf(summary.time),
        preset: 'daily',
      };
    }
    case 'weekdays': {
      return {
        ...base,
        hour: hourOf(summary.time),
        minute: minuteOf(summary.time),
        preset: 'weekdays',
      };
    }
    case 'weekly': {
      return {
        ...base,
        hour: hourOf(summary.time),
        minute: minuteOf(summary.time),
        preset: 'weekly',
        weekday: summary.weekday,
      };
    }
    case 'hourly': {
      return {
        ...base,
        interval: summary.interval,
        minute: summary.minute,
        preset: 'hourly',
      };
    }
    default: {
      return base;
    }
  }
};

export const isValidTaskTemplateCron = (cronPattern: string): boolean =>
  isSupportedTaskTemplateCronPattern(cronPattern.trim());
