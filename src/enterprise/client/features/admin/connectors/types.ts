import type { z } from 'zod';

import type {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDiscoverOutputSchema,
  adminConnectorDraftSchema,
  adminConnectorGetOutputSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorTestOutputSchema,
  adminConnectorUpdateDraftInputSchema,
  connectorCredentialModeSchema,
  connectorOAuthClientSecretMutationSchema,
  connectorSharedSecretMutationSchema,
  connectorToolDraftSchema,
} from '@/server/enterprise/contracts/platformConnectors';

export type AdminConnectorCreateDraftInput = z.infer<typeof adminConnectorCreateDraftInputSchema>;
export type AdminConnectorDiscoverOutput = z.infer<typeof adminConnectorDiscoverOutputSchema>;
export type AdminConnectorDraft = z.infer<typeof adminConnectorDraftSchema>;
export type AdminConnectorGetOutput = z.infer<typeof adminConnectorGetOutputSchema>;
export type AdminConnectorListInput = z.infer<typeof adminConnectorListInputSchema>;
export type AdminConnectorListOutput = z.infer<typeof adminConnectorListOutputSchema>;
export type AdminConnectorListItem = AdminConnectorListOutput['items'][number];
export type AdminConnectorTestOutput = z.infer<typeof adminConnectorTestOutputSchema>;
export type AdminConnectorToolDraft = z.infer<typeof connectorToolDraftSchema>;
export type AdminConnectorUpdateDraftInput = z.infer<typeof adminConnectorUpdateDraftInputSchema>;
export type ConnectorCredentialMode = z.infer<typeof connectorCredentialModeSchema>;
export type ConnectorOAuthClientSecretMutation = z.infer<
  typeof connectorOAuthClientSecretMutationSchema
>;
export type ConnectorSharedSecretMutation = z.infer<typeof connectorSharedSecretMutationSchema>;

/**
 * UI-side dependency boundary used until PR-046 mounts the authoritative admin.connectors router.
 * A production lambdaClient adapter must implement this interface; tests use an explicit Mock.
 */
export interface AdminConnectorCatalogClient {
  get: (input: { id: string }) => Promise<AdminConnectorGetOutput>;
  list: (input: AdminConnectorListInput) => Promise<AdminConnectorListOutput>;
}
