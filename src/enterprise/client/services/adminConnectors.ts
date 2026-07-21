import { withAdminReauthRetry } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminConnectorArchiveInput,
  AdminConnectorCatalogClient,
  AdminConnectorCreateDraftInput,
  AdminConnectorDeleteDraftInput,
  AdminConnectorDiscoverInput,
  AdminConnectorListInput,
  AdminConnectorPublishInput,
  AdminConnectorRevokeAllBindingsInput,
  AdminConnectorRollbackInput,
  AdminConnectorTestInput,
  AdminConnectorUpdateDraftInput,
} from '../features/admin/connectors/types';
import { withAdminAiInfraErrorToast } from './adminAiInfraAdapter/errors';

/** Last applyImmediate/publishNow outcome for draft banner (module-level; admin page only). */
export type AdminConnectorPublishOutcome = {
  connectorId: string;
  published: boolean;
  publishError?: string | null;
};

let lastConnectorPublishOutcome: AdminConnectorPublishOutcome | null = null;

export const getLastAdminConnectorPublishOutcome = () => lastConnectorPublishOutcome;
export const clearLastAdminConnectorPublishOutcome = () => {
  lastConnectorPublishOutcome = null;
};
export const setLastAdminConnectorPublishOutcome = (
  outcome: AdminConnectorPublishOutcome | null,
) => {
  lastConnectorPublishOutcome = outcome;
};

const withToastAndReauth = <T>(fn: () => Promise<T>): Promise<T> =>
  withAdminAiInfraErrorToast(() => withAdminReauthRetry(fn));

class AdminConnectorsService implements AdminConnectorCatalogClient {
  archive = async (input: AdminConnectorArchiveInput) =>
    lambdaClient.admin.connectors.archive.mutate(input);

  createDraft = async (input: AdminConnectorCreateDraftInput) =>
    lambdaClient.admin.connectors.createDraft.mutate(input);

  deleteDraft = async (input: AdminConnectorDeleteDraftInput) =>
    lambdaClient.admin.connectors.deleteDraft.mutate(input);

  discover = async (input: AdminConnectorDiscoverInput) =>
    lambdaClient.admin.connectors.discover.mutate(input);

  get = async (input: { id: string }) => lambdaClient.admin.connectors.get.query(input);

  getPublishedBatch = async (input: { ids: string[] }) =>
    lambdaClient.admin.connectors.getPublishedBatch.query(input);

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
  applyImmediate = async (input: Record<string, unknown> & { mode: string; reason: string }) =>
    withToastAndReauth(async () => {
      const result = await lambdaClient.admin.connectors.applyImmediate.mutate(input as never);
      setLastAdminConnectorPublishOutcome({
        connectorId: result.draft.id,
        published: result.published,
        publishError: result.publishError,
      });
      return result;
    });

  publishNow = async (input: { id: string; reason: string }) =>
    withToastAndReauth(async () => {
      const result = await lambdaClient.admin.connectors.publishNow.mutate(input);
      setLastAdminConnectorPublishOutcome({
        connectorId: result.draft.id,
        published: result.published,
        publishError: result.publishError,
      });
      return result;
    });
}

export const adminConnectorsService = new AdminConnectorsService();
