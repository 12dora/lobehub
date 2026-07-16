import type { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';

import type {
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorListInputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorRevokeAllBindingsInputSchema,
  adminConnectorRollbackInputSchema,
  adminConnectorTestInputSchema,
  adminConnectorUpdateDraftInputSchema,
} from '../../contracts/platformConnectors';
import { adminConnectorGetOutputSchema } from '../../contracts/platformConnectors';
import { ConnectorCatalogReadService } from './catalogSnapshot';
import {
  type ConnectorCatalogSecretStore,
  type ConnectorCatalogServiceOptions,
  noCredentialHeaders,
} from './catalogTypes';
import type { ConnectorOutboundClient } from './connectorOutboundClient';
import { ConnectorCatalogDiscoveryService } from './discoveryService';
import { ConnectorCatalogDraftService } from './draftService';
import { PlatformConnectorContractError } from './errors';
import { ConnectorCatalogPublicationService } from './publicationService';

export class ConnectorCatalogService {
  readonly read: ConnectorCatalogReadService;
  private readonly discovery: ConnectorCatalogDiscoveryService;
  private readonly drafts: ConnectorCatalogDraftService;
  private readonly publication: ConnectorCatalogPublicationService;

  constructor(
    db: LobeChatDatabase,
    outbound: ConnectorOutboundClient,
    secrets: ConnectorCatalogSecretStore,
    options: ConnectorCatalogServiceOptions,
  ) {
    const credentials = options.credentials ?? noCredentialHeaders;
    this.discovery = new ConnectorCatalogDiscoveryService(
      db,
      outbound,
      secrets,
      credentials,
      options.failureAuditWriter,
    );
    this.drafts = new ConnectorCatalogDraftService(
      db,
      secrets,
      options.redirectUri,
      options.failureAuditWriter,
      options.lifecycle,
    );
    this.publication = new ConnectorCatalogPublicationService(
      db,
      outbound,
      secrets,
      options.lifecycle ?? {},
      options.invalidation,
      options.failureAuditWriter,
    );
    this.read = new ConnectorCatalogReadService(db, secrets);
  }

  listDrafts = (input: z.input<typeof adminConnectorListInputSchema>) =>
    this.drafts.listDrafts(input);

  getDraft = async (connectorId: string) => {
    const detail = await this.drafts.getDraft(connectorId);
    let published = null;
    try {
      published = await this.read.getAdminPublished(connectorId);
    } catch (error) {
      if (
        !(error instanceof PlatformConnectorContractError) ||
        error.code !== 'PLATFORM_CONNECTOR_NOT_PUBLISHED'
      ) {
        throw error;
      }
    }
    return adminConnectorGetOutputSchema.parse({
      baseRevision: detail.draft.revision,
      draft: detail.draft,
      draftToken: detail.draftToken,
      published,
    });
  };

  createDraft = (
    actorUserId: string,
    input: z.input<typeof adminConnectorCreateDraftInputSchema>,
  ) => this.drafts.createDraft(actorUserId, input);

  updateDraft = (
    actorUserId: string,
    input: z.input<typeof adminConnectorUpdateDraftInputSchema>,
  ) => this.drafts.updateDraft(actorUserId, input);

  deleteDraft = (
    actorUserId: string,
    input: {
      expectedDraftToken: string;
      expectedRevision: number;
      id: string;
      reason: string;
    },
  ) => this.drafts.deleteDraft(actorUserId, input);

  discover = (actorUserId: string, input: z.input<typeof adminConnectorDiscoverInputSchema>) =>
    this.discovery.discover(actorUserId, input);

  testConnection = (actorUserId: string, input: z.input<typeof adminConnectorTestInputSchema>) =>
    this.discovery.testConnection(actorUserId, input);

  publish = (actorUserId: string, input: z.input<typeof adminConnectorPublishInputSchema>) =>
    this.publication.publish(actorUserId, input);

  rollback = (actorUserId: string, input: z.input<typeof adminConnectorRollbackInputSchema>) =>
    this.publication.rollback(actorUserId, input);

  archive = (actorUserId: string, input: z.input<typeof adminConnectorArchiveInputSchema>) =>
    this.publication.archive(actorUserId, input);

  revokeAllBindings = (
    actorUserId: string,
    input: z.input<typeof adminConnectorRevokeAllBindingsInputSchema>,
  ) => this.publication.revokeAllBindings(actorUserId, input);
}

export type {
  ConnectorCatalogCredentialProvider,
  ConnectorCatalogLifecycle,
  ConnectorCatalogSecretStore,
  ConnectorCatalogServiceOptions,
  ConnectorResolvedSecret,
  ConnectorStoredSecret,
} from './catalogTypes';
