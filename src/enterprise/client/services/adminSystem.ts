import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminSystemCancelJobInput,
  AdminSystemGetInstanceRevisionsInput,
  adminSystemGetInstanceRevisionsOutputSchema,
  AdminSystemGetJobsInput,
  adminSystemGetJobsOutputSchema,
  adminSystemGetStatusOutputSchema,
  AdminSystemRetryJobInput,
} from '@/server/enterprise/contracts/adminSystem';

export type AdminSystemStatus = z.infer<typeof adminSystemGetStatusOutputSchema>;
export type AdminSystemInstanceRevisions = z.infer<
  typeof adminSystemGetInstanceRevisionsOutputSchema
>;
export type AdminSystemJobs = z.infer<typeof adminSystemGetJobsOutputSchema>;
export type AdminSystemJob = AdminSystemJobs['items'][number];

/**
 * Contract-derived client boundary for Admin System/Jobs. Keeping the hook injectable makes the
 * polling and CAS mutation state machines testable without duplicating or weakening the DTOs.
 */
export interface AdminSystemService {
  cancelJob: (input: AdminSystemCancelJobInput) => Promise<AdminSystemJob>;
  getInstanceRevisions: (
    input?: AdminSystemGetInstanceRevisionsInput,
  ) => Promise<AdminSystemInstanceRevisions>;
  getJobs: (input?: AdminSystemGetJobsInput) => Promise<AdminSystemJobs>;
  getStatus: () => Promise<AdminSystemStatus>;
  retryJob: (input: AdminSystemRetryJobInput) => Promise<AdminSystemJob>;
}

class AdminSystemServiceImpl implements AdminSystemService {
  cancelJob = (input: AdminSystemCancelJobInput) =>
    lambdaClient.admin.system.cancelJob.mutate(input);

  getInstanceRevisions = (input?: AdminSystemGetInstanceRevisionsInput) =>
    lambdaClient.admin.system.getInstanceRevisions.query(input);

  getJobs = (input?: AdminSystemGetJobsInput) => lambdaClient.admin.system.getJobs.query(input);

  getStatus = () => lambdaClient.admin.system.getStatus.query();

  retryJob = (input: AdminSystemRetryJobInput) => lambdaClient.admin.system.retryJob.mutate(input);
}

export const adminSystemService: AdminSystemService = new AdminSystemServiceImpl();

export type {
  AdminSystemCancelJobInput,
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemGetJobsInput,
  AdminSystemRetryJobInput,
};
