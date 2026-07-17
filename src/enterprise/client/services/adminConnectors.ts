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
}

export const adminConnectorsService = new AdminConnectorsService();
