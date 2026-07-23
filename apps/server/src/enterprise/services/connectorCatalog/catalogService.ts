import type { z } from 'zod';

import type { LobeChatDatabase } from '@/database/type';

import type {
  adminConnectorApplyImmediateInputSchema,
  adminConnectorArchiveInputSchema,
  adminConnectorCreateDraftInputSchema,
  adminConnectorDiscoverInputSchema,
  adminConnectorListInputSchema,
  adminConnectorPublishInputSchema,
  adminConnectorPublishNowInputSchema,
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

type ApplyImmediateInput = z.input<typeof adminConnectorApplyImmediateInputSchema>;
type PublishNowInput = z.input<typeof adminConnectorPublishNowInputSchema>;

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

  /**
   * Bulk draft detail for admin tool-scope.
   * True batch: 1 connectors + 1 tools + 1 published-runtime query (not N getDraft).
   * Per-id failures are reported in `failedIds` (partial success).
   */
  getDraftBatch = async (ids: string[]) => {
    const draftsById = await this.drafts.loadDraftsBatch(ids);
    const publishedById = await this.read.getAdminPublishedMapBatch(ids);

    const items: Awaited<ReturnType<ConnectorCatalogService['getDraft']>>[] = [];
    const failedIds: string[] = [];
    for (const id of ids) {
      const detail = draftsById.get(id);
      if (!detail) {
        failedIds.push(id);
        continue;
      }
      items.push(
        adminConnectorGetOutputSchema.parse({
          baseRevision: detail.draft.revision,
          draft: detail.draft,
          draftToken: detail.draftToken,
          published: publishedById.get(id) ?? null,
        }),
      );
    }
    return { failedIds, items };
  };

  /** Bounded batch exact published projection (≤100 ids, one query) for agent dependency validation. */
  getPublishedBatch = (ids: string[]) => this.read.getAdminPublishedBatch(ids);

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

  /**
   * Attempt publish; soft-fail returns published:false + publishError (never secrets).
   * When softFail is false and baseRevision > 0, rethrows so the UI can surface failures.
   */
  private tryPublishImmediate = async (
    actorUserId: string,
    connectorId: string,
    reason: string,
    options?: { softFail?: boolean },
  ) => {
    const detail = await this.getDraft(connectorId);
    try {
      const published = await this.publish(actorUserId, {
        expectedDraftToken: detail.draftToken,
        expectedRevision: detail.baseRevision,
        id: connectorId,
        reason,
      });
      const after = await this.getDraft(connectorId);
      return {
        auditId: published.auditId as string | null,
        draft: after.draft,
        draftToken: after.draftToken,
        published: true,
        publishError: null as string | null,
        revision: published.revision,
      };
    } catch (error) {
      const after = await this.getDraft(connectorId);
      const reasonText =
        error instanceof PlatformConnectorContractError
          ? error.code
          : error instanceof Error
            ? error.message.slice(0, 500)
            : 'Publish failed';
      if (options?.softFail || after.baseRevision === 0) {
        return {
          auditId: null as string | null,
          draft: after.draft,
          draftToken: after.draftToken,
          published: false,
          publishError: reasonText,
          revision: after.baseRevision,
        };
      }
      throw error;
    }
  };

  /**
   * Apply a connector draft mutation then publish immediately (admin settings UI parity).
   * Create soft-fails when publish validation fails; update on already-published throws on publish fail.
   */
  applyImmediate = async (actorUserId: string, input: ApplyImmediateInput) => {
    let connectorId: string;
    let softFail: boolean;

    if (input.mode === 'create') {
      softFail = true;
      const { mode: _mode, ...createInput } = input;
      const created = await this.createDraft(
        actorUserId,
        createInput as z.input<typeof adminConnectorCreateDraftInputSchema>,
      );
      connectorId = created.draft.id;
    } else {
      const { mode: _mode, ...updateInput } = input;
      await this.updateDraft(actorUserId, updateInput);
      connectorId = input.id;
      const afterUpdate = await this.getDraft(connectorId);
      softFail = afterUpdate.baseRevision === 0;
    }

    const result = await this.tryPublishImmediate(actorUserId, connectorId, input.reason, {
      softFail,
    });

    // Align with W10-P / skills: update on already-published must surface the real publishError.
    if (!result.published && input.mode === 'update') {
      const after = await this.getDraft(connectorId);
      if (after.baseRevision > 0 && result.publishError) {
        const error = new Error(result.publishError);
        error.name = 'ConnectorPublishImmediateError';
        throw error;
      }
    }

    return result;
  };

  /**
   * Banner "retry publish": re-run publish with soft-fail.
   */
  publishNow = async (actorUserId: string, input: PublishNowInput) =>
    this.tryPublishImmediate(actorUserId, input.id, input.reason, { softFail: true });
}

export type {
  ConnectorCatalogCredentialProvider,
  ConnectorCatalogLifecycle,
  ConnectorCatalogSecretStore,
  ConnectorCatalogServiceOptions,
  ConnectorResolvedSecret,
  ConnectorStoredSecret,
} from './catalogTypes';
