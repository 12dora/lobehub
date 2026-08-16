import type { AdminTaskTemplateListQuery } from './types';

export const ADMIN_TASK_TEMPLATE_LIST_KEY = 'admin.taskTemplates.list' as const;

export const buildAdminTaskTemplateListKey = (input: AdminTaskTemplateListQuery) =>
  [
    ADMIN_TASK_TEMPLATE_LIST_KEY,
    input.enabled ?? '',
    input.limit,
    input.offset,
    input.query ?? '',
  ] as const;
