/**
 * Platform connector catalog shared types (DB-005).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';

import type {
  NewPlatformConnector,
  NewPlatformConnectorTool,
  PlatformConnectorItem,
  PlatformConnectorOAuthStateItem,
  PlatformConnectorSecretSlot,
  PlatformConnectorToolItem,
  platformUserConnectorBindings,
} from '../../schemas/platform/connectors';
import { platformConnectorSecrets } from '../../schemas/platform/connectors';
import type { Transaction } from '../../type';

export const MAX_PLATFORM_CONNECTOR_TOOLS = 1000;

export type ManagedConnectorCreate = Omit<
  NewPlatformConnector,
  | 'legacyConnectionType'
  | 'legacyEncryptedSharedCredentials'
  | 'legacyIsRequired'
  | 'legacyMcpServerUrl'
  | 'legacyMcpStdioConfig'
  | 'legacyName'
  | 'legacyOidcConfig'
  | 'legacySecretFingerprint'
  | 'legacySourceType'
  | 'endpoint'
> & { endpoint: string };

export type ManagedConnectorToolWrite = Omit<
  NewPlatformConnectorTool,
  | 'connectorId'
  | 'legacyAllowUserStricterPolicy'
  | 'legacyLimitConfig'
  | 'legacyManifest'
  | 'legacyPermissionPolicy'
>;

export type ManagedConnectorSecretColumns = Pick<
  ManagedConnectorCreate,
  | 'oauthClientSecretFingerprint'
  | 'oauthClientSecretRef'
  | 'oauthClientSecretUpdatedAt'
  | 'sharedSecretFingerprint'
  | 'sharedSecretRef'
  | 'sharedSecretUpdatedAt'
>;

export const sqlIncrement = (column: typeof platformUserConnectorBindings.revision) =>
  sql`${column} + 1`;

const MANAGED_CONNECTOR_SECRET_REF_PREFIX = 'kms://platform-connectors/';

export const lockManagedConnectorSecret = async (
  db: Transaction,
  params: { connectorId: string; ref: string; slot: PlatformConnectorSecretSlot },
): Promise<void> => {
  if (!params.ref.startsWith(MANAGED_CONNECTOR_SECRET_REF_PREFIX)) return;
  const [secret] = await db
    .select({ id: platformConnectorSecrets.id })
    .from(platformConnectorSecrets)
    .where(
      and(
        eq(platformConnectorSecrets.connectorId, params.connectorId),
        eq(platformConnectorSecrets.ref, params.ref),
        eq(platformConnectorSecrets.slot, params.slot),
        isNull(platformConnectorSecrets.revokedAt),
      ),
    )
    .limit(1)
    .for('update');
  if (!secret) throw new Error('PLATFORM_CONNECTOR_CREDENTIAL_NOT_CONFIGURED');
};

export interface PlatformConnectorCursor {
  connectorKey: string;
  id: string;
}

export interface PlatformConnectorToolCursor {
  id: string;
  sort: number;
  toolKey: string;
}

export type OAuthStateReservationResult =
  | {
      bindingRevision: number;
      reservedAt: Date;
      state: PlatformConnectorOAuthStateItem;
      status: 'reserved';
    }
  | { connectorId: string; pkceVerifierRefs: string[]; status: 'expired' }
  | { status: 'invalid' | 'replayed' };

export interface PlatformConnectorRevisionPayload extends Record<string, unknown> {
  connector: {
    credentialMode: PlatformConnectorItem['credentialMode'];
    description: string | null;
    displayName: string;
    enabled: boolean;
    endpoint: string;
    id: string;
    key: string;
    oauthClientSecretConfigured: boolean;
    oauthClientSecretFingerprint: string | null;
    oauthConfig: PlatformConnectorItem['oauthConfig'];
    sharedSecretConfigured: boolean;
    sharedSecretFingerprint: string | null;
    sort: number;
    transport: PlatformConnectorItem['transport'];
  };
  schemaVersion: 'm09-v1';
  tools: Array<
    Pick<
      PlatformConnectorToolItem,
      | 'description'
      | 'displayName'
      | 'inputSchema'
      | 'outputSchema'
      | 'platformPolicy'
      | 'requiresConfirmation'
      | 'riskLevel'
      | 'sort'
      | 'toolKey'
    >
  >;
}

export interface PlatformConnectorRuntimeRevision {
  payload: PlatformConnectorRevisionPayload;
  provenance: {
    checksum: string;
    connectorId: string;
    publishedAt: Date;
    revision: number;
    revisionId: string;
  };
}

export interface PlatformConnectorExactReference {
  connectorId: string;
  publishedRevision: number;
}

export interface PlatformConnectorExactRuntimeRevision extends PlatformConnectorRuntimeRevision {
  connector: Pick<PlatformConnectorItem, 'connectorKey' | 'id' | 'status'>;
}
