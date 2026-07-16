import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { z as zod } from 'zod';

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

import {
  adminConnectorCreateDraftInputSchema,
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
import type {
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

interface PersistedSecretSlots {
  oauthClientSecretFingerprint: string | null;
  oauthClientSecretRef: string | null;
  oauthClientSecretUpdatedAt: Date | null;
  sharedSecretFingerprint: string | null;
  sharedSecretRef: string | null;
  sharedSecretUpdatedAt: Date | null;
}

const deleteDraftInputSchema = zod
  .object({
    expectedDraftToken: zod.string().length(64),
    expectedRevision: zod.number().int().nonnegative(),
    id: zod.string().trim().min(1).max(128),
    reason: zod.string().trim().min(1).max(2000),
  })
  .strict();

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
    private readonly redirectUri: string,
  ) {}

  private appendFailureAudit = async (action: string, actorUserId: string, targetId?: string) => {
    await new PlatformAuditService(this.db).append({
      action,
      actorUserId,
      reason: null,
      result: 'failure',
      targetId: targetId ?? null,
      targetType: 'connector',
    });
  };

  private persistSlot = async (
    connectorId: string,
    slot: ConnectorSecretSlot,
    configured: boolean,
    mutation: { operation: 'clear' | 'keep' | 'replace'; value?: unknown } | undefined,
    current: ConnectorStoredSecret | null,
  ): Promise<ConnectorStoredSecret | null> => {
    if (!configured || mutation?.operation === 'clear') return null;
    if (mutation?.operation === 'replace') {
      return assertStoredSecret(
        await this.secrets.persistSecret({ connectorId, slot, value: mutation.value }),
      );
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
    try {
      const secretContext = await loadTrustedConnectorSecretContext(this.secrets, connectorId, {
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
          serverRedirectUri: this.redirectUri,
          toolIds: (command.tools ?? []).map(() => randomUUID()),
        },
        secretContext,
      );
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
          afterDiff: { draft: after.draft },
          reason: normalized.command.reason,
          result: 'success',
          targetId: connectorId,
          targetType: 'connector',
        });
        return after;
      });
    } catch (error) {
      await this.appendFailureAudit('admin.connectors.createDraft', actorUserId, connectorId);
      throw error;
    }
  };

  updateDraft = async (
    actorUserId: string,
    input: UpdateDraftInput,
  ): Promise<ConnectorDraftDetail> => {
    const patch = adminConnectorUpdateDraftInputSchema.parse(input);
    try {
      const secretContext = await loadTrustedConnectorSecretContext(this.secrets, patch.id, {
        oauthClientSecret:
          patch.oauthClientSecret?.operation === 'replace'
            ? patch.oauthClientSecret.value
            : undefined,
        sharedSecret:
          patch.sharedSecret?.operation === 'replace' ? patch.sharedSecret.value : undefined,
      });
      return await this.db.transaction(async (tx) => {
        const [connector] = await tx
          .select()
          .from(platformConnectors)
          .where(eq(platformConnectors.id, patch.id))
          .limit(1)
          .for('update');
        if (!connector) throw new PlatformConnectorContractError('PLATFORM_CONNECTOR_NOT_FOUND');
        const current = await loadConnectorDraft(tx, patch.id);
        if (
          current.draft.revision !== patch.expectedRevision ||
          current.draftToken !== patch.expectedDraftToken
        ) {
          throw new PlatformRevisionConflictError();
        }
        const normalized = normalizeAdminConnectorUpdateInput(
          current.draft,
          patch,
          this.redirectUri,
          secretContext,
        );
        const secretSlots = await this.persistDraftSecrets(
          patch.id,
          normalized.candidate,
          connector,
          normalized.patch,
        );
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
          afterDiff: { draft: after.draft },
          beforeDiff: { draft: current.draft },
          configRevision: after.draft.revision,
          reason: normalized.patch.reason,
          result: 'success',
          targetId: patch.id,
          targetType: 'connector',
        });
        return after;
      });
    } catch (error) {
      await this.appendFailureAudit('admin.connectors.updateDraft', actorUserId, patch.id);
      throw error;
    }
  };

  deleteDraft = async (actorUserId: string, input: z.input<typeof deleteDraftInputSchema>) => {
    const command = deleteDraftInputSchema.parse(input);
    try {
      const sources = await this.secrets.loadCurrentSecretSources(command.id);
      const reason = assertConnectorPersistentTextSafe(
        command.reason,
        collectConnectorSecretLeaves(sources.oauthClientSecret, sources.sharedSecret),
      );
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
          beforeDiff: { draft: current.draft },
          reason,
          result: 'success',
          targetId: command.id,
          targetType: 'connector',
        });
        return { auditId: audit.id };
      });
    } catch (error) {
      await this.appendFailureAudit('admin.connectors.deleteDraft', actorUserId, command.id);
      throw error;
    }
  };
}
