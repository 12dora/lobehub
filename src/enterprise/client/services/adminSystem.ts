import type { z } from 'zod';

import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileRegenerateInput,
  AdminBrowserProfileSummary,
  AdminBrowserProfileUpdateInput,
} from '@/server/enterprise/contracts/adminBrowserProfile';
import type {
  adminSystemCancelDocumentRenderJobInputSchema,
  AdminSystemCancelJobInput,
  adminSystemGetDocumentRenderSettingsOutputSchema,
  adminSystemGetDocumentRenderStatusOutputSchema,
  adminSystemGetInfraSettingsOutputSchema,
  AdminSystemGetInstanceRevisionsInput,
  adminSystemGetInstanceRevisionsOutputSchema,
  AdminSystemGetJobsInput,
  adminSystemGetJobsOutputSchema,
  adminSystemGetSandboxSettingsOutputSchema,
  adminSystemGetStatusOutputSchema,
  AdminSystemRetryJobInput,
  AdminSystemTestDependencyInput,
  adminSystemTestDependencyOutputSchema,
  AdminSystemUpdateDocumentRenderSettingsInput,
  AdminSystemUpdateInfraSettingsInput,
  AdminSystemUpdateInfraSettingsOutput,
  AdminSystemUpdateSandboxSettingsInput,
  AdminSystemUpdateSandboxSettingsOutput,
} from '@/server/enterprise/contracts/adminSystem';

export type AdminSystemStatus = z.infer<typeof adminSystemGetStatusOutputSchema>;
export type AdminSystemInstanceRevisions = z.infer<
  typeof adminSystemGetInstanceRevisionsOutputSchema
>;
export type AdminSystemJobs = z.infer<typeof adminSystemGetJobsOutputSchema>;
export type AdminSystemJob = AdminSystemJobs['items'][number];
export type AdminSystemInfraSettings = z.infer<typeof adminSystemGetInfraSettingsOutputSchema>;
export type AdminSystemSandboxSettings = z.infer<typeof adminSystemGetSandboxSettingsOutputSchema>;
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

export interface AdminSandboxSettingsService {
  getSandboxSettings: () => Promise<AdminSystemSandboxSettings>;
  updateSandboxSettings: (
    input: AdminSystemUpdateSandboxSettingsInput,
  ) => Promise<AdminSystemUpdateSandboxSettingsOutput>;
}

/**
 * 文档渲染 (Gotenberg sidecar) admin contract, inferred from the server schemas so the card and the
 * procedures can never drift apart.
 */
export type AdminSystemDocumentRenderSettings = z.infer<
  typeof adminSystemGetDocumentRenderSettingsOutputSchema
>;
/** The effective values, resolved as `DB ?? env ?? default`; `endpoint` is null when unset. */
export type AdminSystemDocumentRenderConfig = AdminSystemDocumentRenderSettings['config'];
export type AdminSystemDocumentRenderStatus = z.infer<
  typeof adminSystemGetDocumentRenderStatusOutputSchema
>;
export type AdminSystemDocumentRenderQueue = AdminSystemDocumentRenderStatus['queue'];
export type AdminSystemDocumentRenderSidecar = AdminSystemDocumentRenderStatus['sidecar'];
/** One recent render job. Identified by file id + extension — never by the file's name. */
export type AdminSystemDocumentRenderJob = AdminSystemDocumentRenderQueue['recent'][number];
export type AdminSystemDocumentRenderJobActionInput = z.infer<
  typeof adminSystemCancelDocumentRenderJobInputSchema
>;

export interface AdminDocumentRenderSettingsService {
  cancelDocumentRenderJob: (
    input: AdminSystemDocumentRenderJobActionInput,
  ) => Promise<{ ok: boolean }>;
  getDocumentRenderSettings: () => Promise<AdminSystemDocumentRenderSettings>;
  getDocumentRenderStatus: () => Promise<AdminSystemDocumentRenderStatus>;
  retryDocumentRenderJob: (
    input: AdminSystemDocumentRenderJobActionInput,
  ) => Promise<{ ok: boolean }>;
  /** `testDependency({ dependency: 'documentRender' })` — probes Gotenberg `/health`. */
  testDocumentRender: () => Promise<AdminSystemTestDependencyResult>;
  updateDocumentRenderSettings: (
    input: AdminSystemUpdateDocumentRenderSettingsInput,
  ) => Promise<AdminSystemDocumentRenderSettings>;
}

export interface AdminBrowserProfileService {
  getBrowserProfile: () => Promise<AdminBrowserProfileSummary>;
  /** The curated pools a fingerprint may be composed from — the card never posts raw values. */
  getBrowserProfileOptions: () => Promise<AdminBrowserProfileOptions>;
  regenerateBrowserProfile: (
    input: AdminBrowserProfileRegenerateInput,
  ) => Promise<AdminBrowserProfileSummary>;
  updateBrowserProfile: (
    input: AdminBrowserProfileUpdateInput,
  ) => Promise<AdminBrowserProfileSummary>;
}

class AdminSystemServiceImpl
  implements
    AdminSystemService,
    AdminInfraSettingsService,
    AdminBrowserProfileService,
    AdminSandboxSettingsService,
    AdminDocumentRenderSettingsService
{
  cancelDocumentRenderJob = (input: AdminSystemDocumentRenderJobActionInput) =>
    lambdaClient.admin.system.cancelDocumentRenderJob.mutate(input);

  cancelJob = (input: AdminSystemCancelJobInput) =>
    lambdaClient.admin.system.cancelJob.mutate(input);

  getDocumentRenderSettings = () => lambdaClient.admin.system.getDocumentRenderSettings.query();

  getDocumentRenderStatus = () => lambdaClient.admin.system.getDocumentRenderStatus.query();

  retryDocumentRenderJob = (input: AdminSystemDocumentRenderJobActionInput) =>
    lambdaClient.admin.system.retryDocumentRenderJob.mutate(input);

  /** One shared dependency probe rather than a sixth procedure to register. */
  testDocumentRender = () =>
    lambdaClient.admin.system.testDependency.mutate({ dependency: 'documentRender' });

  updateDocumentRenderSettings = (input: AdminSystemUpdateDocumentRenderSettingsInput) =>
    lambdaClient.admin.system.updateDocumentRenderSettings.mutate(input);

  getInfraSettings = () => lambdaClient.admin.system.getInfraSettings.query();

  getBrowserProfile = () => lambdaClient.admin.browserProfile.get.query();

  getBrowserProfileOptions = () => lambdaClient.admin.browserProfile.options.query();

  getInstanceRevisions = (input?: AdminSystemGetInstanceRevisionsInput) =>
    lambdaClient.admin.system.getInstanceRevisions.query(input);

  getJobs = (input?: AdminSystemGetJobsInput) => lambdaClient.admin.system.getJobs.query(input);

  getSandboxSettings = () => lambdaClient.admin.system.getSandboxSettings.query();

  getStatus = () => lambdaClient.admin.system.getStatus.query();

  retryJob = (input: AdminSystemRetryJobInput) => lambdaClient.admin.system.retryJob.mutate(input);

  regenerateBrowserProfile = (input: AdminBrowserProfileRegenerateInput) =>
    lambdaClient.admin.browserProfile.regenerate.mutate(input);

  testDependency = (input: AdminSystemTestDependencyInput) =>
    lambdaClient.admin.system.testDependency.mutate(input);

  updateBrowserProfile = (input: AdminBrowserProfileUpdateInput) =>
    lambdaClient.admin.browserProfile.update.mutate(input);

  updateInfraSettings = (input: AdminSystemUpdateInfraSettingsInput) =>
    lambdaClient.admin.system.updateInfraSettings.mutate(input);

  updateSandboxSettings = (input: AdminSystemUpdateSandboxSettingsInput) =>
    lambdaClient.admin.system.updateSandboxSettings.mutate(input);
}

export const adminSystemService: AdminSystemService &
  AdminInfraSettingsService &
  AdminBrowserProfileService &
  AdminSandboxSettingsService &
  AdminDocumentRenderSettingsService = new AdminSystemServiceImpl();

export type {
  AdminSystemCancelJobInput,
  AdminSystemGetInstanceRevisionsInput,
  AdminSystemGetJobsInput,
  AdminSystemRetryJobInput,
  AdminSystemTestDependencyInput,
  AdminSystemUpdateDocumentRenderSettingsInput,
  AdminSystemUpdateInfraSettingsInput,
  AdminSystemUpdateInfraSettingsOutput,
  AdminSystemUpdateSandboxSettingsInput,
  AdminSystemUpdateSandboxSettingsOutput,
};
export type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileRegenerateInput,
  AdminBrowserProfileSummary,
  AdminBrowserProfileUpdateInput,
};
