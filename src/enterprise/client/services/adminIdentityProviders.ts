import { lambdaClient } from '@/libs/trpc/client';
import type {
  AdminSystemPrepareRestartInput,
  AdminSystemRequestRestartInput,
} from '@/server/enterprise/contracts/adminSystem';
import type {
  AdminIdentityProviderCreateInput,
  AdminIdentityProviderListInput,
  AdminIdentityProviderUpdateInput,
} from '@/server/enterprise/contracts/identityProviders';

class AdminIdentityProvidersService {
  create = (input: AdminIdentityProviderCreateInput) =>
    lambdaClient.admin.identityProviders.create.mutate(input);
  disable = (input: { expectedRevision: number; id: string; reason: string }) =>
    lambdaClient.admin.identityProviders.disable.mutate(input);
  discover = (input: { issuer: string }) =>
    lambdaClient.admin.identityProviders.discover.mutate(input);
  getCallbackUrls = () => lambdaClient.admin.identityProviders.getCallbackUrls.query();
  list = (input: AdminIdentityProviderListInput) =>
    lambdaClient.admin.identityProviders.list.query(input);
  listPublishedRevisions = (id: string) =>
    lambdaClient.admin.identityProviders.listPublishedRevisions.query({ id });
  publish = (input: { expectedRevision: number; id: string; reason: string; requestId: string }) =>
    lambdaClient.admin.identityProviders.publish.mutate(input);
  rollback = (input: {
    expectedRevision: number;
    id: string;
    reason: string;
    requestId: string;
    targetRevision: number;
  }) => lambdaClient.admin.identityProviders.rollback.mutate(input);
  testResult = (attemptId: string) =>
    lambdaClient.admin.identityProviders.testResult.query({ attemptId });
  testStart = (input: { expectedRevision: number; id: string; reason: string }) =>
    lambdaClient.admin.identityProviders.testStart.mutate(input);
  update = (input: AdminIdentityProviderUpdateInput) =>
    lambdaClient.admin.identityProviders.update.mutate(input);
  validateNetwork = (input: { issuer: string }) =>
    lambdaClient.admin.identityProviders.validateNetwork.mutate(input);

  getAuthSnapshotStatus = () => lambdaClient.admin.system.getAuthSnapshotStatus.query();
  prepareRestart = (input: AdminSystemPrepareRestartInput) =>
    lambdaClient.admin.system.prepareRestart.mutate(input);
  requestRestart = (input: AdminSystemRequestRestartInput) =>
    lambdaClient.admin.system.requestRestart.mutate(input);
}

export const adminIdentityProvidersService = new AdminIdentityProvidersService();
