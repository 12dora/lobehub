/**
 * Strict Zod contracts for identity providers (admin + published drafts).
 *
 * Implementation is split by subdomain under `./identityProviders/`; this file is the stable
 * public barrel so existing `.../contracts/identityProviders` import paths remain valid.
 */

export {
  adminIdentityProviderCallbackUrlsOutputSchema,
  type AdminIdentityProviderCreateInput,
  adminIdentityProviderCreateInputSchema,
  adminIdentityProviderDeleteInputSchema,
  adminIdentityProviderDeleteOutputSchema,
  adminIdentityProviderDisableInputSchema,
  adminIdentityProviderDisableOutputSchema,
  adminIdentityProviderDiscoverInputSchema,
  adminIdentityProviderDiscoveryOutputSchema,
  adminIdentityProviderGetInputSchema,
  adminIdentityProviderGetOutputSchema,
  type AdminIdentityProviderListInput,
  adminIdentityProviderListInputSchema,
  adminIdentityProviderListOutputSchema,
  adminIdentityProviderMutationOutputSchema,
  adminIdentityProviderPublishInputSchema,
  adminIdentityProviderPublishOutputSchema,
  adminIdentityProviderRevisionHistoryOutputSchema,
  adminIdentityProviderRollbackInputSchema,
  adminIdentityProviderRollbackOutputSchema,
  type AdminIdentityProviderUpdateInput,
  adminIdentityProviderUpdateInputSchema,
  adminIdentityProviderValidateNetworkOutputSchema,
} from './identityProviders/admin';
export {
  identityProviderAllowedCorpsSchema,
  identityProviderClaimMappingSchema,
  identityProviderIssuerSchema,
  identityProviderScopesSchema,
  identityProviderSecretMutationSchema,
  identityProviderSecretStateSchema,
  identityProviderStatusSchema,
  identityProviderTypeSchema,
} from './identityProviders/common';
export {
  identityProviderDraftSchema,
  NO_REASON_AUDIT_PLACEHOLDER,
  oidcDiscoveryMetadataSchema,
  optionalReasonSchema,
} from './identityProviders/draft';
export {
  adminIdentityProviderTestResultInputSchema,
  adminIdentityProviderTestResultOutputSchema,
  adminIdentityProviderTestStartInputSchema,
  adminIdentityProviderTestStartOutputSchema,
  identityProviderClaimPreviewSchema,
  identityProviderClaimValidationIssueSchema,
} from './identityProviders/testing';
