export type {
  AdminTaskTemplateConnector,
  AdminTaskTemplateCreateInput,
  AdminTaskTemplateImportOutput,
  AdminTaskTemplateItem,
  AdminTaskTemplateListInput,
  AdminTaskTemplateListOutput,
  AdminTaskTemplateReorderInput,
  AdminTaskTemplateUpdateInput,
} from '@/server/enterprise/contracts/adminTaskTemplates';

/**
 * Where the rows on screen come from.
 *
 * Always `'managed'` while the module is on (the catalog is platform-owned in every state).
 * `'unmanaged'` is kept so older cached responses still type-check.
 */
export type AdminTaskTemplateOrigin = 'managed' | 'unmanaged';

/** Resolved list-query input (defaults already applied by the page). */
export interface AdminTaskTemplateListQuery {
  enabled?: boolean;
  limit: number;
  /**
   * Console locale. Forwarded so a first-run auto-seed (and the import action) write the
   * operator's own language.
   */
  locale?: string;
  offset: number;
  query?: string;
}
