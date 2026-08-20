export type {
  AdminAgentTemplateCreateInput,
  AdminAgentTemplateImportOutput,
  AdminAgentTemplateItem,
  AdminAgentTemplateListInput,
  AdminAgentTemplateListOutput,
  AdminAgentTemplateReorderInput,
  AdminAgentTemplateUpdateInput,
} from '@/server/enterprise/contracts/adminAgentTemplates';

/**
 * Where the rows on screen come from.
 *
 * `'managed'` — the platform catalog owns the list: real rows, every write available.
 * `'unmanaged'` — the catalog is still empty, so the list answers with read-only PREVIEW rows
 * (`preview:<identifier>`, `revision: 0`) of the bundled library users are actually being served.
 * Nothing about a preview row can be written; importing or creating one entry flips the whole
 * catalog to `'managed'`.
 */
export type AdminAgentTemplateOrigin = 'managed' | 'unmanaged';

/** Resolved list-query input (defaults already applied by the page). */
export interface AdminAgentTemplateListQuery {
  enabled?: boolean;
  limit: number;
  /**
   * Console locale. The preview rows of the bundled library are resolved in it, exactly like the
   * copy the import action writes, so the table shows the operator's own language.
   */
  locale?: string;
  offset: number;
  query?: string;
}
