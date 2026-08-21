import type { AdminTaskTemplateListQuery } from './types';

export const ADMIN_TASK_TEMPLATE_LIST_KEY = 'admin.taskTemplates.list' as const;

/**
 * `locale` is part of the key: first-run auto-seed writes the console language, so two locales
 * are two different pages until the catalog is seeded.
 */
export const buildAdminTaskTemplateListKey = (input: AdminTaskTemplateListQuery) =>
  [
    ADMIN_TASK_TEMPLATE_LIST_KEY,
    input.enabled ?? '',
    input.limit,
    input.locale ?? '',
    input.offset,
    input.query ?? '',
  ] as const;
