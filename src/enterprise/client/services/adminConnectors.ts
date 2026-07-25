import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminConnectorApplyImmediateInput,
  AdminConnectorApplyImmediateOutput,
  AdminConnectorArchiveInput,
  AdminConnectorCatalogClient,
  AdminConnectorCreateDraftInput,
  AdminConnectorDeleteDraftInput,
  AdminConnectorDiscoverInput,
  AdminConnectorGovernanceGetOutput,
  AdminConnectorListInput,
  AdminConnectorPublishInput,
  AdminConnectorPublishNowInput,
  AdminConnectorRevokeAllBindingsInput,
  AdminConnectorRollbackInput,
  AdminConnectorSetSharedAuthorizationInput,
  AdminConnectorTestInput,
  AdminConnectorUpdateBuiltinToolPolicyInput,
  AdminConnectorUpdateDraftInput,
} from '../features/admin/connectors/types';
import { withAdminAiInfraErrorToast } from './adminAiInfraAdapter/errors';

const withToastAndReauth = <T>(fn: () => Promise<T>): Promise<T> =>
  withAdminAiInfraErrorToast(() => withAdminReauthRetry(fn));

class AdminConnectorsService implements AdminConnectorCatalogClient {
  archive = async (input: AdminConnectorArchiveInput) =>
    lambdaClient.admin.connectors.archive.mutate(input);

  /** Settings-page archive with reauth + toast (advanced catalog keeps bare archive). */
  archiveImmediate = async (input: AdminConnectorArchiveInput) =>
    withToastAndReauth(() => lambdaClient.admin.connectors.archive.mutate(input));

  createDraft = async (input: AdminConnectorCreateDraftInput) =>
    lambdaClient.admin.connectors.createDraft.mutate(input);

  /** Settings-page draft delete with reauth + toast (parity with archiveImmediate). */
  deleteDraft = async (input: AdminConnectorDeleteDraftInput) =>
    withToastAndReauth(() => lambdaClient.admin.connectors.deleteDraft.mutate(input));

  discover = async (input: AdminConnectorDiscoverInput) =>
    lambdaClient.admin.connectors.discover.mutate(input);

  get = async (input: { id: string }) => lambdaClient.admin.connectors.get.query(input);

  /**
   * Bulk draft detail (tools + CAS tokens). One RPC for up to 50 ids;
   * `failedIds` reports partial failures without aborting the batch.
   */
  getBatch = async (input: { ids: string[] }) =>
    lambdaClient.admin.connectors.getBatch.query(input);

  getGovernance = async (): Promise<AdminConnectorGovernanceGetOutput> =>
    lambdaClient.admin.connectors.getGovernance.query();

  getPublishedBatch = async (input: { ids: string[] }) =>
    lambdaClient.admin.connectors.getPublishedBatch.query(input);

  /** Dangerous: switches whose OAuth identity every managed user runs with (reauth + toast). */
  setSharedAuthorization = async (input: AdminConnectorSetSharedAuthorizationInput) =>
    withToastAndReauth(() => lambdaClient.admin.connectors.setSharedAuthorization.mutate(input));

  updateBuiltinToolPolicy = async (input: AdminConnectorUpdateBuiltinToolPolicyInput) =>
    withToastAndReauth(() => lambdaClient.admin.connectors.updateBuiltinToolPolicy.mutate(input));

  list = async (input: AdminConnectorListInput) => lambdaClient.admin.connectors.list.query(input);

  publish = async (input: AdminConnectorPublishInput) =>
    lambdaClient.admin.connectors.publish.mutate(input);

  revokeAllBindings = async (input: AdminConnectorRevokeAllBindingsInput) =>
    lambdaClient.admin.connectors.revokeAllBindings.mutate(input);

  rollback = async (input: AdminConnectorRollbackInput) =>
    lambdaClient.admin.connectors.rollback.mutate(input);

  test = async (input: AdminConnectorTestInput) => lambdaClient.admin.connectors.test.mutate(input);

  updateDraft = async (input: AdminConnectorUpdateDraftInput) =>
    lambdaClient.admin.connectors.updateDraft.mutate(input);

  /**
   * Draft mutation + immediate publish (admin settings UI parity).
   * Soft-fail leaves draft + banner; hard failures toast via wrapper.
   */
  applyImmediate = async (
    input: AdminConnectorApplyImmediateInput,
  ): Promise<AdminConnectorApplyImmediateOutput> =>
    withToastAndReauth(() => lambdaClient.admin.connectors.applyImmediate.mutate(input));

  publishNow = async (
    input: AdminConnectorPublishNowInput,
  ): Promise<AdminConnectorApplyImmediateOutput> =>
    withToastAndReauth(() => lambdaClient.admin.connectors.publishNow.mutate(input));
}

export const adminConnectorsService = new AdminConnectorsService();
