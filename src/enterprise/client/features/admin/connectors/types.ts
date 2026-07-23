import type { z } from 'zod';

import type {
  adminConnectorGovernanceGetOutputSchema,
  adminConnectorSetSharedAuthorizationInputSchema,
  adminConnectorUpdateBuiltinToolPolicyInputSchema,
} from '@/server/enterprise/contracts/platformConnectorGovernance';
import type {
  adminConnectorApplyImmediateInputSchema,
  adminConnectorApplyImmediateOutputSchema,
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDeleteDraftOutputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorDraftMutationOutputSchema,
  adminConnectorDraftSchema,
  adminConnectorGetBatchInputSchema,
  adminConnectorGetBatchOutputSchema,
  adminConnectorGetOutputSchema,
  adminConnectorGetPublishedBatchInputSchema,
  adminConnectorGetPublishedBatchOutputSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorPublishNowInputSchema,
  adminConnectorRevisionOutputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRevokeAllBindingsOutputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorTestOutputSchema,
  adminConnectorUpdateDraftInputSchema,
  connectorCredentialModeSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorSharedSecretMutationSchema,
  connectorToolDraftSchema,
} from '@/server/enterprise/contracts/platformConnectors';

export type AdminConnectorApplyImmediateInput = z.input<
  typeof adminConnectorApplyImmediateInputSchema
>;
export type AdminConnectorApplyImmediateOutput = z.output<
  typeof adminConnectorApplyImmediateOutputSchema
>;
export type AdminConnectorArchiveInput = z.infer<typeof adminConnectorArchiveInputSchema>;
export type AdminConnectorCreateDraftInput = z.infer<typeof adminConnectorCreateDraftInputSchema>;
export type AdminConnectorDeleteDraftInput = z.infer<typeof adminConnectorDeleteDraftInputSchema>;
export type AdminConnectorDeleteDraftOutput = z.infer<typeof adminConnectorDeleteDraftOutputSchema>;
export type AdminConnectorDiscoverInput = z.infer<typeof adminConnectorDiscoverInputSchema>;
export type AdminConnectorDiscoverOutput = z.infer<typeof adminConnectorDiscoverOutputSchema>;
export type AdminConnectorDraft = z.infer<typeof adminConnectorDraftSchema>;
export type AdminConnectorDraftMutationOutput = z.infer<
  typeof adminConnectorDraftMutationOutputSchema
>;
export type AdminConnectorGetOutput = z.infer<typeof adminConnectorGetOutputSchema>;
export type AdminConnectorGetBatchInput = z.infer<typeof adminConnectorGetBatchInputSchema>;
export type AdminConnectorGetBatchOutput = z.infer<typeof adminConnectorGetBatchOutputSchema>;
export type AdminConnectorGovernanceGetOutput = z.infer<
  typeof adminConnectorGovernanceGetOutputSchema
>;
export type AdminConnectorSetSharedAuthorizationInput = z.infer<
  typeof adminConnectorSetSharedAuthorizationInputSchema
>;
export type AdminConnectorUpdateBuiltinToolPolicyInput = z.infer<
  typeof adminConnectorUpdateBuiltinToolPolicyInputSchema
>;
export type AdminConnectorGetPublishedBatchInput = z.infer<
  typeof adminConnectorGetPublishedBatchInputSchema
>;
export type AdminConnectorGetPublishedBatchOutput = z.infer<
  typeof adminConnectorGetPublishedBatchOutputSchema
>;
export type AdminConnectorListInput = z.infer<typeof adminConnectorListInputSchema>;
export type AdminConnectorListOutput = z.infer<typeof adminConnectorListOutputSchema>;
export type AdminConnectorListItem = AdminConnectorListOutput['items'][number];
export type AdminConnectorPublishInput = z.infer<typeof adminConnectorPublishInputSchema>;
export type AdminConnectorPublishNowInput = z.input<typeof adminConnectorPublishNowInputSchema>;
export type AdminConnectorRevisionOutput = z.infer<typeof adminConnectorRevisionOutputSchema>;
export type AdminConnectorRevokeAllBindingsInput = z.infer<
  typeof adminConnectorRevokeAllBindingsInputSchema
>;
export type AdminConnectorRevokeAllBindingsOutput = z.infer<
  typeof adminConnectorRevokeAllBindingsOutputSchema
>;
export type AdminConnectorRollbackInput = z.infer<typeof adminConnectorRollbackInputSchema>;
export type AdminConnectorTestInput = z.infer<typeof adminConnectorTestInputSchema>;
export type AdminConnectorTestOutput = z.infer<typeof adminConnectorTestOutputSchema>;
export type AdminConnectorToolDraft = z.infer<typeof connectorToolDraftSchema>;
export type AdminConnectorUpdateDraftInput = z.infer<typeof adminConnectorUpdateDraftInputSchema>;
export type ConnectorCredentialMode = z.infer<typeof connectorCredentialModeSchema>;
export type ConnectorOAuthClientSecretMutation = z.infer<
  typeof connectorOAuthClientSecretMutationSchema
>;
export type ConnectorSharedSecretMutation = z.infer<typeof connectorSharedSecretMutationSchema>;

/**
 * Production uses the real lambda adapter. Tests may inject an explicit Mock at the SWR boundary.
 */
export interface AdminConnectorCatalogClient {
  archive: (input: AdminConnectorArchiveInput) => Promise<AdminConnectorRevisionOutput>;
  createDraft: (
    input: AdminConnectorCreateDraftInput,
  ) => Promise<AdminConnectorDraftMutationOutput>;
  deleteDraft: (input: AdminConnectorDeleteDraftInput) => Promise<AdminConnectorDeleteDraftOutput>;
  discover: (input: AdminConnectorDiscoverInput) => Promise<AdminConnectorDiscoverOutput>;
  get: (input: { id: string }) => Promise<AdminConnectorGetOutput>;
  getBatch: (input: AdminConnectorGetBatchInput) => Promise<AdminConnectorGetBatchOutput>;
  getPublishedBatch: (
    input: AdminConnectorGetPublishedBatchInput,
  ) => Promise<AdminConnectorGetPublishedBatchOutput>;
  list: (input: AdminConnectorListInput) => Promise<AdminConnectorListOutput>;
  publish: (input: AdminConnectorPublishInput) => Promise<AdminConnectorRevisionOutput>;
  revokeAllBindings: (
    input: AdminConnectorRevokeAllBindingsInput,
  ) => Promise<AdminConnectorRevokeAllBindingsOutput>;
  rollback: (input: AdminConnectorRollbackInput) => Promise<AdminConnectorRevisionOutput>;
  test: (input: AdminConnectorTestInput) => Promise<AdminConnectorTestOutput>;
  updateDraft: (
    input: AdminConnectorUpdateDraftInput,
  ) => Promise<AdminConnectorDraftMutationOutput>;
}
