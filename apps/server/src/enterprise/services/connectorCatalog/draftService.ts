import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { z } from 'zod';

import { checksumPayload, PlatformRevisionConflictError } from '@/database/models/platform';
import { PlatformConnectorCatalogRepository } from '@/database/repositories/platformConnectorCatalog';
import {
  type NewPlatformConnectorTool,
  type PlatformConnectorItem,
  platformConnectors,
  type PlatformConnectorToolItem,
  platformConnectorTools,
} from '@/database/schemas/platform';
import type { LobeChatDatabase, Transaction } from '@/database/type';

import type {
  ConnectorCurrentSecretLoader,
  ConnectorSecretSlotSources,
  TrustedConnectorSecretContext,
} from '../../contracts/platformConnectors';
import {
  adminConnectorCreateDraftInputSchema,
  adminConnectorDeleteDraftInputSchema,
  adminConnectorDraftSchema,
  adminConnectorListInputSchema,
  adminConnectorListOutputSchema,
  adminConnectorUpdateDraftInputSchema,
  collectConnectorSecretLeaves,
  loadTrustedConnectorSecretContext,
  normalizeAdminConnectorCreateInput,
  normalizeAdminConnectorUpdateInput,
} from '../../contracts/platformConnectors';
import { PlatformAuditService } from '../platformAudit';
import type { ConnectorFailureAuditWriter } from './catalogAudit';
import {
  appendConnectorFailureAudit,
  connectorAuditSummary,
  loadConnectorSecretSourcesSafe,
  sanitizeConnectorReason,
  throwStableConnectorSecretError,
} from './catalogAudit';
import type {
  ConnectorCatalogLifecycle,
  ConnectorCatalogSecretStore,
  ConnectorDraft,
  ConnectorDraftDetail,
  ConnectorSecretSlot,
  ConnectorStoredSecret,
} from './catalogTypes';
import { PlatformConnectorContractError } from './errors';
import { assertConnectorPersistentTextSafe } from './secretBoundary';

type CreateDraftInput = z.input<typeof adminConnectorCreateDraftInputSchema>;
type UpdateDraftInput = z.input<typeof adminConnectorUpdateDraftInputSchema>;

const loadTrustedSecretContextSafe = async (
  loader: ConnectorCurrentSecretLoader,
  connectorId: string,
  replacement: ConnectorSecretSlotSources,
): Promise<TrustedConnectorSecretContext> => {
  try {
    return await loadTrustedConnectorSecretContext(loader, connectorId, replacement);
  } catch (error) {
    return throwStableConnectorSecretError(error);
  }
};

interface PersistedSecretSlots {
  oauthClientSecretFingerprint: string | null;
  oauthClientSecretRef: string | null;
  oauthClientSecretUpdatedAt: Date | null;
  sharedSecretFingerprint: string | null;
  sharedSecretRef: string | null;
  sharedSecretUpdatedAt: Date | null;
}

const currentSlot = (
  connector: PlatformConnectorItem | undefined,
  slot: ConnectorSecretSlot,
): ConnectorStoredSecret | null => {
  const prefix = slot === 'oauthClientSecret' ? 'oauthClientSecret' : 'sharedSecret';
  const ref = connector?.[`${prefix}Ref`];
  const fingerprint = connector?.[`${prefix}Fingerprint`];
  const updatedAt = connector?.[`${prefix}UpdatedAt`];
  return ref && fingerprint && updatedAt ? { fingerprint, ref, updatedAt } : null;
};

const toSlotColumns = (
  oauthClientSecret: ConnectorStoredSecret | null,
  sharedSecret: ConnectorStoredSecret | null,
): PersistedSecretSlots => ({
  oauthClientSecretFingerprint: oauthClientSecret?.fingerprint ?? null,
  oauthClientSecretRef: oauthClientSecret?.ref ?? null,
  oauthClientSecretUpdatedAt: oauthClientSecret?.updatedAt ?? null,
  sharedSecretFingerprint: sharedSecret?.fingerprint ?? null,
  sharedSecretRef: sharedSecret?.ref ?? null,
  sharedSecretUpdatedAt: sharedSecret?.updatedAt ?? null,
});

const assertStoredSecret = (value: ConnectorStoredSecret): ConnectorStoredSecret => {
  if (
    (!value.ref.startsWith('vault://') && !value.ref.startsWith('kms://')) ||
    value.fingerprint.length === 0
  ) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_SECRET_EXPOSURE_BLOCKED');
  }
  return value;
};

export const connectorDraftToken = (draft: ConnectorDraft): string =>
  checksumPayload({ draft, revision: draft.revision });

export const connectorToolInsertValues = (
  tools: ConnectorDraft['tools'],
): Array<Omit<NewPlatformConnectorTool, 'connectorId'>> =>
  tools.map((tool) => ({
    description: tool.description,
    displayName: tool.displayName,
    enabled: tool.enabled,
    id: tool.id,
    inputSchema: tool.inputSchema,
    legacyAllowUserStricterPolicy: true,
    legacyManifest: {
      description: tool.description ?? undefined,
      inputSchema: tool.inputSchema,
      name: tool.toolKey,
      outputSchema: tool.outputSchema,
    },
    legacyPermissionPolicy: 'needs_approval',
    outputSchema: tool.outputSchema,
    platformPolicy: tool.platformPolicy,
    requiresConfirmation: tool.requiresConfirmation,
    riskLevel: tool.riskLevel,
    sort: tool.sort,
    toolKey: tool.toolKey,
  }));

const toDraft = (
  connector: PlatformConnectorItem,
  tools: PlatformConnectorToolItem[],
): ConnectorDraft => {
  if (connector.migrationRequired || !connector.endpoint) {
    throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_PUBLISHED');
  }
  const common = {
    connectionTest: null,
    description: connector.description,
    displayName: connector.displayName,
    enabled: connector.enabled,
    endpoint: connector.endpoint,
    id: connector.id,
    key: connector.connectorKey,
    revision: connector.revision,
    sort: connector.sort,
    status: connector.status,
    tools: tools.map((tool) => ({
      description: tool.description,
      displayName: tool.displayName,
      enabled: tool.enabled,
      id: tool.id,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      platformPolicy: tool.platformPolicy,
      requiresConfirmation: tool.requiresConfirmation,
      riskLevel: tool.riskLevel,
      sort: tool.sort,
      toolKey: tool.toolKey,
    })),
    transport: connector.transport,
  } as const;
  const empty = { configured: false, fingerprint: null, updatedAt: null } as const;
  if (connector.credentialMode === 'none') {
    return adminConnectorDraftSchema.parse({
      ...common,
      credentialMode: 'none',
      oauthClientSecret: empty,
      oauthConfig: null,
      sharedSecret: empty,
    });
  }
  if (connector.credentialMode === 'shared_service_account') {
    return adminConnectorDraftSchema.parse({
      ...common,
      credentialMode: 'shared_service_account',
      oauthClientSecret: empty,
      oauthConfig: null,
      sharedSecret: {
        configured: connector.sharedSecretRef !== null,
        fingerprint: connector.sharedSecretFingerprint,
        updatedAt: connector.sharedSecretUpdatedAt,
      },
    });
  }
  return adminConnectorDraftSchema.parse({
    ...common,
    credentialMode: 'per_user_oauth',
    oauthClientSecret: {
      configured: connector.oauthClientSecretRef !== null,
      fingerprint: connector.oauthClientSecretFingerprint,
      updatedAt: connector.oauthClientSecretUpdatedAt,
    },
    oauthConfig: connector.oauthConfig,
    sharedSecret: empty,
  });
};

const listAllTools = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
): Promise<PlatformConnectorToolItem[]> => {
  const repository = new PlatformConnectorCatalogRepository(db);
  const tools: PlatformConnectorToolItem[] = [];
  let cursor: Awaited<ReturnType<typeof repository.listTools>>['nextCursor'] = null;
  do {
    const page = await repository.listTools({
      connectorId,
      cursor: cursor ?? undefined,
      limit: 100,
    });
    tools.push(...page.items);
    if (tools.length > 1000) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_TRANSPORT_UNSUPPORTED');
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
};

export const loadConnectorDraft = async (
  db: LobeChatDatabase | Transaction,
  connectorId: string,
): Promise<ConnectorDraftDetail> => {
  const repository = new PlatformConnectorCatalogRepository(db);
  const connector = await repository.getConnector(connectorId);
  if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
  const draft = toDraft(connector, await listAllTools(db, connectorId));
  return { draft, draftToken: connectorDraftToken(draft) };
};

export class ConnectorCatalogDraftService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly secrets: ConnectorCatalogSecretStore,
    private readonly redirectUri: string | (() => string | undefined),
    private readonly failureAuditWriter?: ConnectorFailureAuditWriter,
    private readonly lifecycle: ConnectorCatalogLifecycle = {},
  ) {}

  private resolveRedirectUri = (credentialMode: ConnectorDraft['credentialMode']) =>
    credentialMode === 'per_user_oauth'
      ? typeof this.redirectUri === 'function'
        ? this.redirectUri()
        : this.redirectUri
      : undefined;

  private persistSlot = async (
    connectorId: string,
    slot: ConnectorSecretSlot,
    configured: boolean,
    mutation: { operation: 'clear' | 'keep' | 'replace'; value?: unknown } | undefined,
    current: ConnectorStoredSecret | null,
  ): Promise<ConnectorStoredSecret | null> => {
    if (!configured || mutation?.operation === 'clear') return null;
    if (mutation?.operation === 'replace') {
      try {
        return assertStoredSecret(
          await this.secrets.persistSecret({ connectorId, slot, value: mutation.value }),
        );
      } catch (error) {
        return throwStableConnectorSecretError(error);
      }
    }
    if (!current) {
      throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
    }
    return current;
  };

  private persistDraftSecrets = async (
    connectorId: string,
    draft: ConnectorDraft,
    connector: PlatformConnectorItem | undefined,
    command: {
      oauthClientSecret?: { operation: 'clear' | 'keep' | 'replace'; value?: unknown };
      sharedSecret?: { operation: 'clear' | 'keep' | 'replace'; value?: unknown };
    },
  ): Promise<PersistedSecretSlots> => {
    const oauth = await this.persistSlot(
      connectorId,
      'oauthClientSecret',
      draft.oauthClientSecret.configured,
      command.oauthClientSecret,
      currentSlot(connector, 'oauthClientSecret'),
    );
    const shared = await this.persistSlot(
      connectorId,
      'sharedSecret',
      draft.sharedSecret.configured,
      command.sharedSecret,
      currentSlot(connector, 'sharedSecret'),
    );
    return toSlotColumns(oauth, shared);
  };

  getDraft = async (connectorId: string): Promise<ConnectorDraftDetail> =>
    loadConnectorDraft(this.db, connectorId);

  listDrafts = async (input: z.input<typeof adminConnectorListInputSchema>) => {
    const command = adminConnectorListInputSchema.parse(input);
    const page = await new PlatformConnectorCatalogRepository(this.db).listConnectors({
      credentialMode: command.credentialMode,
      cursor: command.cursor,
      enabled: command.enabled,
      limit: command.limit,
      query: command.query,
      status: command.status,
    });
    const items = page.items.map((item) => {
      const { tools: _tools, ...draft } = toDraft(item, []);
      return draft;
    });
    return adminConnectorListOutputSchema.parse({
      items,
      nextCursor: page.nextCursor?.connectorKey ?? null,
    });
  };

  createDraft = async (
    actorUserId: string,
    input: CreateDraftInput,
  ): Promise<ConnectorDraftDetail> => {
    const command = adminConnectorCreateDraftInputSchema.parse(input);
    const connectorId = randomUUID();
    let safeReason: string | null = null;
    try {
      const secretContext = await loadTrustedSecretContextSafe(this.secrets, connectorId, {
        oauthClientSecret:
          command.credentialMode === 'per_user_oauth' &&
          command.oauthClientSecret?.operation === 'replace'
            ? command.oauthClientSecret.value
            : undefined,
        sharedSecret:
          command.credentialMode === 'shared_service_account' &&
          command.sharedSecret?.operation === 'replace'
            ? command.sharedSecret.value
            : undefined,
      });
      const normalized = normalizeAdminConnectorCreateInput(
        command,
        {
          id: connectorId,
          serverRedirectUri: this.resolveRedirectUri(command.credentialMode),
          toolIds: (command.tools ?? []).map(() => randomUUID()),
        },
        secretContext,
      );
      safeReason = normalized.command.reason;
      const mutations = {
        oauthClientSecret:
          normalized.command.credentialMode === 'per_user_oauth'
            ? normalized.command.oauthClientSecret
            : undefined,
        sharedSecret:
          normalized.command.credentialMode === 'shared_service_account'
            ? normalized.command.sharedSecret
            : undefined,
      };
      const secretSlots = await this.persistDraftSecrets(
        connectorId,
        normalized.draft,
        undefined,
        mutations,
      );
      return await this.db.transaction(async (tx) => {
        const repository = new PlatformConnectorCatalogRepository(tx);
        await repository.createConnector({
          ...secretSlots,
          connectorKey: normalized.draft.key,
          createdBy: actorUserId,
          credentialMode: normalized.draft.credentialMode,
          description: normalized.draft.description,
          displayName: normalized.draft.displayName,
          enabled: normalized.draft.enabled,
          endpoint: normalized.draft.endpoint,
          id: connectorId,
          oauthConfig: normalized.draft.oauthConfig,
          sort: normalized.draft.sort,
          status: 'draft',
          transport: 'http',
          updatedBy: actorUserId,
        });
        await repository.replaceTools(
          connectorId,
          connectorToolInsertValues(normalized.draft.tools),
        );
        const after = await loadConnectorDraft(tx, connectorId);
        await new PlatformAuditService(tx).append({
          action: 'admin.connectors.createDraft',
          actorUserId,
          afterDiff: {
            connector: connectorAuditSummary(after.draft, [
              'credentialMode',
              'description',
              'displayName',
              'enabled',
              'endpoint',
              'key',
              'oauthConfig',
              'sort',
              'tools',
              'transport',
            ]),
          },
          reason: normalized.command.reason,
          result: 'success',
          targetId: connectorId,
          targetType: 'connector',
        });
        return after;
      });
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.createDraft',
          actorUserId,
          reason: safeReason,
          targetId: connectorId,
        },
        this.failureAuditWriter,
      );
      throw error;
    }
  };

  updateDraft = async (
    actorUserId: string,
    input: UpdateDraftInput,
  ): Promise<ConnectorDraftDetail> => {
    const patch = adminConnectorUpdateDraftInputSchema.parse(input);
    let safeReason: string | null = null;
    try {
      const currentSources = await loadConnectorSecretSourcesSafe(this.secrets, patch.id);
      const replacementLeaves = collectConnectorSecretLeaves(
        patch.oauthClientSecret?.operation === 'replace'
          ? patch.oauthClientSecret.value
          : undefined,
        patch.sharedSecret?.operation === 'replace' ? patch.sharedSecret.value : undefined,
      );
      safeReason = assertConnectorPersistentTextSafe(
        patch.reason,
        new Set([
          ...collectConnectorSecretLeaves(
            currentSources.oauthClientSecret,
            currentSources.sharedSecret,
          ),
          ...replacementLeaves,
        ]),
      );
      const secretContext = await loadTrustedSecretContextSafe(this.secrets, patch.id, {
        oauthClientSecret:
          patch.oauthClientSecret?.operation === 'replace'
            ? patch.oauthClientSecret.value
            : undefined,
        sharedSecret:
          patch.sharedSecret?.operation === 'replace' ? patch.sharedSecret.value : undefined,
      });
      const connector = await new PlatformConnectorCatalogRepository(this.db).getConnector(
        patch.id,
      );
      if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
      const current = await loadConnectorDraft(this.db, patch.id);
      if (
        current.draft.revision !== patch.expectedRevision ||
        current.draftToken !== patch.expectedDraftToken
      ) {
        throw new PlatformRevisionConflictError();
      }
      const normalized = normalizeAdminConnectorUpdateInput(
        current.draft,
        patch,
        this.resolveRedirectUri(patch.credentialMode ?? current.draft.credentialMode),
        secretContext,
      );
      // Persist immutable Secret handles before acquiring the database row lock.
      // A losing CAS may leave an unreachable handle, which is safe to garbage collect.
      const secretSlots = await this.persistDraftSecrets(
        patch.id,
        normalized.candidate,
        connector,
        normalized.patch,
      );
      await this.lifecycle.afterDraftSecretPersist?.(patch.id);
      return await this.db.transaction(async (tx) => {
        const [lockedConnector] = await tx
          .select()
          .from(platformConnectors)
          .where(eq(platformConnectors.id, patch.id))
          .limit(1)
          .for('update');
        if (!lockedConnector) {
          throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
        }
        const lockedCurrent = await loadConnectorDraft(tx, patch.id);
        if (
          lockedCurrent.draft.revision !== patch.expectedRevision ||
          lockedCurrent.draftToken !== patch.expectedDraftToken
        ) {
          throw new PlatformRevisionConflictError();
        }
        const repository = new PlatformConnectorCatalogRepository(tx);
        const updated = await repository.updateConnectorDraftCas(patch.id, patch.expectedRevision, {
          ...secretSlots,
          connectorKey: normalized.candidate.key,
          credentialMode: normalized.candidate.credentialMode,
          description: normalized.candidate.description,
          displayName: normalized.candidate.displayName,
          enabled: normalized.candidate.enabled,
          endpoint: normalized.candidate.endpoint,
          oauthConfig: normalized.candidate.oauthConfig,
          sort: normalized.candidate.sort,
          transport: 'http',
          updatedBy: actorUserId,
        });
        if (!updated) throw new PlatformRevisionConflictError();
        await repository.replaceTools(
          patch.id,
          connectorToolInsertValues(normalized.candidate.tools),
        );
        const after = await loadConnectorDraft(tx, patch.id);
        await new PlatformAuditService(tx).append({
          action: 'admin.connectors.updateDraft',
          actorUserId,
          afterDiff: {
            connector: connectorAuditSummary(
              after.draft,
              Object.keys(normalized.patch).filter(
                (key) => !['expectedDraftToken', 'expectedRevision', 'id', 'reason'].includes(key),
              ),
            ),
          },
          beforeDiff: { connector: connectorAuditSummary(lockedCurrent.draft) },
          configRevision: after.draft.revision,
          reason: normalized.patch.reason,
          result: 'success',
          targetId: patch.id,
          targetType: 'connector',
        });
        return after;
      });
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.updateDraft',
          actorUserId,
          reason: safeReason,
          targetId: patch.id,
        },
        this.failureAuditWriter,
      );
      throw error;
    }
  };

  deleteDraft = async (
    actorUserId: string,
    input: z.input<typeof adminConnectorDeleteDraftInputSchema>,
  ) => {
    const command = adminConnectorDeleteDraftInputSchema.parse(input);
    let safeReason: string | null = null;
    try {
      safeReason = await sanitizeConnectorReason(this.secrets, command.id, command.reason);
      return await this.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(platformConnectors)
          .where(eq(platformConnectors.id, command.id))
          .limit(1)
          .for('update');
        if (!locked) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
        const current = await loadConnectorDraft(tx, command.id);
        if (
          locked.publishedRevision !== null ||
          locked.revision !== command.expectedRevision ||
          current.draftToken !== command.expectedDraftToken
        ) {
          throw new PlatformRevisionConflictError();
        }
        await tx
          .delete(platformConnectorTools)
          .where(eq(platformConnectorTools.connectorId, command.id));
        await tx.delete(platformConnectors).where(eq(platformConnectors.id, command.id));
        const audit = await new PlatformAuditService(tx).append({
          action: 'admin.connectors.deleteDraft',
          actorUserId,
          beforeDiff: { connector: connectorAuditSummary(current.draft) },
          reason: safeReason,
          result: 'success',
          targetId: command.id,
          targetType: 'connector',
        });
        return { auditId: audit.id };
      });
    } catch (error) {
      await appendConnectorFailureAudit(
        this.db,
        {
          action: 'admin.connectors.deleteDraft',
          actorUserId,
          reason: safeReason,
          targetId: command.id,
        },
        this.failureAuditWriter,
      );
      throw error;
    }
  };
}
