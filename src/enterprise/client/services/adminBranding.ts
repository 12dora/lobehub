import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminBrandingGetOutput,
  AdminBrandingSaveInput,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

export type {
  AdminBrandingGetOutput,
  AdminBrandingPayload,
  AdminBrandingSaveInput,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

class AdminBrandingService {
  get = async (): Promise<AdminBrandingGetOutput> => lambdaClient.admin.branding.get.query();

  save = async (input: AdminBrandingSaveInput): Promise<AdminBrandingGetOutput> =>
    lambdaClient.admin.branding.save.mutate(input);

  uploadAsset = async (input: AdminBrandingUploadAssetInput) =>
    lambdaClient.admin.branding.uploadAsset.mutate(input);
}

export const adminBrandingService = new AdminBrandingService();
