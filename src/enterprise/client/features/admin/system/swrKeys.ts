import type {
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemGetJobsInput,
} from '@/enterprise/client/services/adminSystem';

export const ADMIN_SYSTEM_STATUS_KEY = 'admin.system.getStatus';
export const ADMIN_SYSTEM_INSTANCES_KEY = 'admin.system.getInstanceRevisions';
export const ADMIN_SYSTEM_JOBS_KEY = 'admin.system.getJobs';
export const ADMIN_SYSTEM_JOBS_POLL_KEY = 'admin.system.getJobs.poll';

export const buildAdminSystemStatusKey = (enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_STATUS_KEY] as const) : null;

export const buildAdminSystemInstancesKey = (
  input: AdminSystemGetInstanceRevisionsInput,
  enabled: boolean,
) => (enabled ? ([ADMIN_SYSTEM_INSTANCES_KEY, input] as const) : null);

export const buildAdminSystemJobsKey = (input: AdminSystemGetJobsInput, enabled: boolean) =>
  enabled ? ([ADMIN_SYSTEM_JOBS_KEY, input] as const) : null;

export const buildAdminSystemJobsPollKey = (enabled: boolean, limit: number) =>
  enabled ? ([ADMIN_SYSTEM_JOBS_POLL_KEY, limit] as const) : null;
