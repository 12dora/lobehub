/**
 * Strict Zod contracts for platform connectors (admin + user + runtime).
 *
 * Implementation is split by subdomain under `./platformConnectors/`; this file is the stable
 * public barrel so existing `.../contracts/platformConnectors` import paths remain valid.
 */

export {
  adminConnectorOAuthConfigSchema,
  CONNECTOR_OPERATION_MESSAGE_BY_STATUS,
  connectorBindingStatusSchema,
  connectorConnectionTestStateSchema,
  connectorCredentialModeSchema,
  connectorLifecycleStatusSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorPlatformToolPolicySchema,
  connectorReturnToSchema,
  connectorRiskLevelSchema,
  connectorSafeMessageSchema,
  connectorScopesSchema,
  connectorSecretStateSchema,
  connectorSharedCredentialSchema,
  connectorSharedSecretMutationSchema,
  connectorToolDraftSchema,
  containsConnectorCredentialMaterial,
  PlatformConnectorContractError,
  type PlatformConnectorErrorCode,
  platformConnectorErrorCodeSchema,
  publishedConnectorToolSchema,
  reasonSchema,
  webConnectorTransportSchema,
} from './platformConnectors/common';
export {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDeleteDraftOutputSchema,
  adminConnectorDraftMutationOutputSchema,
  adminConnectorDraftSchema,
  type AdminConnectorGetBatchInput,
  adminConnectorGetBatchInputSchema,
  type AdminConnectorGetBatchOutput,
  adminConnectorGetBatchOutputSchema,
  adminConnectorGetInputSchema,
  adminConnectorGetOutputSchema,
  type AdminConnectorGetPublishedBatchInput,
  adminConnectorGetPublishedBatchInputSchema,
  type AdminConnectorGetPublishedBatchOutput,
  adminConnectorGetPublishedBatchOutputSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorUpdateDraftInputSchema,
  adminPublishedConnectorSchema,
} from './platformConnectors/draft';
export {
  adminConnectorCreateDerivedInputSchema,
  normalizeAdminConnectorCreateInput,
  normalizeAdminConnectorUpdateInput,
} from './platformConnectors/normalize';
export {
  connectorOAuthCallbackInputSchema,
  connectorOAuthStatePayloadSchema,
  connectorOAuthTokenResponseSchema,
} from './platformConnectors/oauth';
export {
  type AdminConnectorApplyImmediateInput,
  adminConnectorApplyImmediateInputSchema,
  type AdminConnectorApplyImmediateOutput,
  adminConnectorApplyImmediateOutputSchema,
  adminConnectorArchiveInputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorPublishInputSchema,
  type AdminConnectorPublishNowInput,
  adminConnectorPublishNowInputSchema,
  adminConnectorRevisionOutputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRevokeAllBindingsOutputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorTestOutputSchema,
} from './platformConnectors/publication';
export {
  connectorApprovalReceiptSchema,
  connectorDependencySelectionSchema,
  connectorEffectiveToolPolicyInputSchema,
  connectorEffectiveToolPolicyOutputSchema,
  connectorOperationProofSchema,
  connectorOwnedOperationProofSchema,
  connectorRuntimeResolutionSchema,
  trustedPublishedConnectorSchema,
} from './platformConnectors/runtime';
export {
  collectConnectorSecretLeaves,
  type ConnectorCurrentSecretLoader,
  type ConnectorSecretSlotSources,
  loadTrustedConnectorSecretContext,
  type TrustedConnectorSecretContext,
} from './platformConnectors/secrets';
export {
  connectorAuthorizationAttemptIdSchema,
  connectorBindingSchema,
  managedConnectorSchema,
  managedConnectorToolSchema,
  userConnectorDisconnectInputSchema,
  userConnectorDisconnectOutputSchema,
  userConnectorGetAuthorizationStatusInputSchema,
  userConnectorGetAuthorizationStatusOutputSchema,
  userConnectorListManagedInputSchema,
  userConnectorListManagedOutputSchema,
  userConnectorStartAuthorizationInputSchema,
  userConnectorStartAuthorizationOutputSchema,
} from './platformConnectors/user';
