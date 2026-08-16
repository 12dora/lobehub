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

/** Resolved list-query input (defaults already applied by the page). */
export interface AdminTaskTemplateListQuery {
  enabled?: boolean;
  limit: number;
  offset: number;
  query?: string;
}
