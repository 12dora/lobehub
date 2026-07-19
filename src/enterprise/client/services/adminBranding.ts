import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminBrandingGetDraftOutput,
  AdminBrandingPublishInput,
  AdminBrandingRollbackInput,
  AdminBrandingSaveDraftInput,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

class AdminBrandingService {
  getDraft = async (): Promise<AdminBrandingGetDraftOutput> =>
    lambdaClient.admin.branding.getDraft.query();

  publish = async (input: AdminBrandingPublishInput) =>
    lambdaClient.admin.branding.publish.mutate(input);

  rollback = async (input: AdminBrandingRollbackInput) =>
    lambdaClient.admin.branding.rollback.mutate(input);

  saveDraft = async (input: AdminBrandingSaveDraftInput) =>
    lambdaClient.admin.branding.saveDraft.mutate(input);

  uploadAsset = async (input: AdminBrandingUploadAssetInput) =>
    lambdaClient.admin.branding.uploadAsset.mutate(input);
}

export const adminBrandingService = new AdminBrandingService();
