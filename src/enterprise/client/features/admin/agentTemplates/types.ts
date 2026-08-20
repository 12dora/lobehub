export type {
  AdminAgentTemplateCreateInput,
  AdminAgentTemplateImportOutput,
  AdminAgentTemplateItem,
  AdminAgentTemplateListInput,
  AdminAgentTemplateListOutput,
  AdminAgentTemplateReorderInput,
  AdminAgentTemplateUpdateInput,
} from '@/server/enterprise/contracts/adminAgentTemplates';

/** Resolved list-query input (defaults already applied by the page). */
export interface AdminAgentTemplateListQuery {
  enabled?: boolean;
  limit: number;
  offset: number;
  query?: string;
}
