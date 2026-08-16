import type { InterestAreaKey } from './interests';

export const TASK_TEMPLATE_ICONS = ['github'] as const;

export type TaskTemplateIcon = (typeof TASK_TEMPLATE_ICONS)[number];

export const TASK_TEMPLATE_CATEGORIES = [
  'content-creation',
  'engineering',
  'design',
  'learning-research',
  'business',
  'marketing',
  'product',
  'sales-customer',
  'operations',
  'hr',
  'finance-legal',
  'creator',
  'investing',
  'parenting',
  'health',
  'hobbies',
  'personal-life',
] as const;

export type TaskTemplateCategory = (typeof TASK_TEMPLATE_CATEGORIES)[number];

export type TaskTemplateConnectorSource = 'composio' | 'lobehub';

export interface TaskTemplateConnectorReference {
  /** Short identifier from `LOBEHUB_SKILL_PROVIDERS[i].id` or `COMPOSIO_APP_TYPES[i].identifier`. */
  identifier: string;
  source: TaskTemplateConnectorSource;
}

export interface TaskTemplateConnector extends TaskTemplateConnectorReference {
  /** Whether this connector must be authorized before the task can be created. */
  required: boolean;
}

export interface TaskTemplate {
  category: TaskTemplateCategory;
  connectors: TaskTemplateConnector[];
  cronPattern: string;
  description: string;
  /** Optional icon identifier; consumers resolve it to a component. */
  icon?: TaskTemplateIcon;
  /**
   * Market rows carry a numeric market id; platform-managed rows carry their table id (text).
   * Consumers use it only as a React key and for the market-only dismiss / recordCreated calls.
   */
  id: number | string;
  identifier: string;
  instruction: string;
  interests: InterestAreaKey[];
  title: string;
}

/**
 * Categories that only make sense in a personal context. When the recommendation
 * is requested from inside a workspace, every template under these categories
 * is removed from the candidate pool — both matched and fallback — so a team
 * dashboard never surfaces "bedtime gratitude" / "weekly family finance" etc.
 */
export const TASK_TEMPLATE_PERSONAL_ONLY_CATEGORIES: TaskTemplateCategory[] = [
  'parenting',
  'health',
  'hobbies',
  'personal-life',
];

export const TASK_TEMPLATE_RECOMMEND_COUNT = 3;

export const TASK_TEMPLATE_RECOMMEND_MAX_COUNT = 10;

const isCronNumber = (value: string, max: number) => {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= max;
};

const isCronStep = (value: string, max: number) => {
  if (!/^\*\/\d+$/.test(value)) return false;
  const parsed = Number.parseInt(value.slice(2), 10);
  return parsed >= 1 && parsed <= max;
};

const isCronNumberList = (value: string, max: number) =>
  value.split(',').every((item) => isCronNumber(item, max));

/**
 * The scheduled-task runtime only understands minute / hour / weekday, so a task-template
 * cron must leave day-of-month and month as `*`. Shared by the market recommendation parser,
 * the platform task-template admin contracts, and the admin editor form.
 */
export const isSupportedTaskTemplateCronPattern = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;

  const parts = value.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, weekday] = parts;
  if (
    !(minute === '*' || isCronNumberList(minute, 59) || isCronStep(minute, 59)) ||
    !(hour === '*' || isCronNumberList(hour, 23) || isCronStep(hour, 24))
  ) {
    return false;
  }
  if (dayOfMonth !== '*' || month !== '*') return false;

  return weekday === '*' || isCronNumberList(weekday, 6);
};
