import type { z } from 'zod';

import type { Transaction } from '@/database/type';

import type {
  adminConnectorDraftSchema,
  ConnectorCurrentSecretLoader,
} from '../../contracts/platformConnectors';
import type { PlatformConfigInvalidationPublisher } from '../platformConfigInvalidation';
import type { ConnectorFailureAuditWriter } from './catalogAudit';
import { PlatformConnectorContractError } from './errors';

export type ConnectorDraft = z.infer<typeof adminConnectorDraftSchema>;
export type ConnectorSecretSlot =
  'oauthBindingToken' | 'oauthClientSecret' | 'oauthPkceVerifier' | 'sharedSecret';

export interface ConnectorStoredSecret {
  fingerprint: string;
  ref: string;
  updatedAt: Date;
}

export interface ConnectorResolvedSecret extends ConnectorStoredSecret {
  value: unknown;
}

export interface ConnectorCatalogSecretStore extends ConnectorCurrentSecretLoader {
  persistSecret: (params: {
    connectorId: string;
    slot: ConnectorSecretSlot;
    value: unknown;
  }) => Promise<ConnectorStoredSecret>;
  resolveSecretRef: (params: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }) => Promise<ConnectorResolvedSecret | null>;
  resolveSecretVersion: (params: {
    connectorId: string;
    fingerprint: string;
    slot: ConnectorSecretSlot;
  }) => Promise<ConnectorResolvedSecret | null>;
  revokeSecretRef?: (params: {
    connectorId: string;
    ref: string;
    slot: ConnectorSecretSlot;
  }) => Promise<void>;
}

export interface ConnectorCatalogCredentialProvider {
  getHeaders: (params: {
    connectorId: string;
    credentialMode: ConnectorDraft['credentialMode'];
  }) => Promise<Record<string, string>>;
}

export interface ConnectorCatalogLifecycle {
  afterDraftSecretPersist?: (connectorId: string) => Promise<void>;
  afterPublicationPreflight?: (connectorId: string) => Promise<void>;
  afterRevokeAll?: (connectorId: string, tx: Transaction) => Promise<void>;
}

export interface ConnectorCatalogServiceOptions {
  credentials?: ConnectorCatalogCredentialProvider;
  failureAuditWriter?: ConnectorFailureAuditWriter;
  invalidation?: PlatformConfigInvalidationPublisher;
  lifecycle?: ConnectorCatalogLifecycle;
  redirectUri: string;
}

export interface ConnectorDraftDetail {
  draft: ConnectorDraft;
  draftToken: string;
}

export const noCredentialHeaders: ConnectorCatalogCredentialProvider = {
  getHeaders: async ({ credentialMode }) => {
    if (credentialMode !== 'none') {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    return {};
  },
};
