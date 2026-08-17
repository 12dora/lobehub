import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminBrowserProfileRegenerateInput,
  AdminBrowserProfileSummary,
} from '@/server/enterprise/contracts/adminBrowserProfile';
import type {
  AdminSystemCancelJobInput,
  adminSystemGetInfraSettingsOutputSchema,
  AdminSystemGetInstanceRevisionsInput,
  adminSystemGetInstanceRevisionsOutputSchema,
  AdminSystemGetJobsInput,
  adminSystemGetJobsOutputSchema,
  adminSystemGetStatusOutputSchema,
  AdminSystemRetryJobInput,
  AdminSystemTestDependencyInput,
  adminSystemTestDependencyOutputSchema,
  AdminSystemUpdateInfraSettingsInput,
  AdminSystemUpdateInfraSettingsOutput,
} from '@/server/enterprise/contracts/adminSystem';

export type AdminSystemStatus = z.infer<typeof adminSystemGetStatusOutputSchema>;
export type AdminSystemInstanceRevisions = z.infer<
  typeof adminSystemGetInstanceRevisionsOutputSchema
>;
export type AdminSystemJobs = z.infer<typeof adminSystemGetJobsOutputSchema>;
export type AdminSystemJob = AdminSystemJobs['items'][number];
export type AdminSystemInfraSettings = z.infer<typeof adminSystemGetInfraSettingsOutputSchema>;
export type AdminSystemTestDependencyResult = z.infer<typeof adminSystemTestDependencyOutputSchema>;

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

export interface AdminInfraSettingsService {
  getInfraSettings: () => Promise<AdminSystemInfraSettings>;
  testDependency: (
    input: AdminSystemTestDependencyInput,
  ) => Promise<AdminSystemTestDependencyResult>;
  updateInfraSettings: (
    input: AdminSystemUpdateInfraSettingsInput,
  ) => Promise<AdminSystemUpdateInfraSettingsOutput>;
}

export interface AdminBrowserProfileService {
  getBrowserProfile: () => Promise<AdminBrowserProfileSummary>;
  regenerateBrowserProfile: (
    input: AdminBrowserProfileRegenerateInput,
  ) => Promise<AdminBrowserProfileSummary>;
}

class AdminSystemServiceImpl
  implements AdminSystemService, AdminInfraSettingsService, AdminBrowserProfileService
{
  cancelJob = (input: AdminSystemCancelJobInput) =>
    lambdaClient.admin.system.cancelJob.mutate(input);

  getInfraSettings = () => lambdaClient.admin.system.getInfraSettings.query();

  getBrowserProfile = () => lambdaClient.admin.browserProfile.get.query();

  getInstanceRevisions = (input?: AdminSystemGetInstanceRevisionsInput) =>
    lambdaClient.admin.system.getInstanceRevisions.query(input);

  getJobs = (input?: AdminSystemGetJobsInput) => lambdaClient.admin.system.getJobs.query(input);

  getStatus = () => lambdaClient.admin.system.getStatus.query();

  retryJob = (input: AdminSystemRetryJobInput) => lambdaClient.admin.system.retryJob.mutate(input);

  regenerateBrowserProfile = (input: AdminBrowserProfileRegenerateInput) =>
    lambdaClient.admin.browserProfile.regenerate.mutate(input);

  testDependency = (input: AdminSystemTestDependencyInput) =>
    lambdaClient.admin.system.testDependency.mutate(input);

  updateInfraSettings = (input: AdminSystemUpdateInfraSettingsInput) =>
    lambdaClient.admin.system.updateInfraSettings.mutate(input);
}

export const adminSystemService: AdminSystemService &
  AdminInfraSettingsService &
  AdminBrowserProfileService = new AdminSystemServiceImpl();

export type {
  AdminSystemCancelJobInput,
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemGetJobsInput,
  AdminSystemRetryJobInput,
  AdminSystemTestDependencyInput,
  AdminSystemUpdateInfraSettingsInput,
  AdminSystemUpdateInfraSettingsOutput,
};
export type { AdminBrowserProfileRegenerateInput, AdminBrowserProfileSummary };
