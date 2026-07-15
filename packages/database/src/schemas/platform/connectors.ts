import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import type { PlatformResourceStatus } from './common';

/**
 * Platform Connector definitions (M09). Empty shell in Migration 0.
 * Shared credentials are envelope-encrypted; OAuth secrets never appear in revision JSON.
 */
export const platformConnectors = pgTable(
  'platform_connectors',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectors', 16))
      .primaryKey()
      .notNull(),

    connectorKey: varchar('connector_key', { length: 128 }).notNull(),
    name: text('name').notNull(),
    description: text('description'),
    sourceType: varchar('source_type', { length: 32 }).notNull().default('custom'),
    connectionType: varchar('connection_type', { length: 32 }).notNull().default('http'),
    mcpServerUrl: text('mcp_server_url'),
    mcpStdioConfig: jsonb('mcp_stdio_config').$type<Record<string, unknown>>(),
    credentialMode: varchar('credential_mode', { length: 64 }).notNull().default('per_user_oauth'),
    /** OAuth client config with secrets stripped / referenced by secret_ref. */
    oidcConfig: jsonb('oidc_config').$type<Record<string, unknown>>(),
    encryptedSharedCredentials: text('encrypted_shared_credentials'),
    secretFingerprint: text('secret_fingerprint'),
    isRequired: boolean('is_required').notNull().default(false),
    enabled: boolean('enabled').notNull().default(false),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_connectors_connector_key_unique').on(t.connectorKey),
    index('platform_connectors_status_idx').on(t.status),
  ],
);

export type PlatformConnectorItem = typeof platformConnectors.$inferSelect;
export type NewPlatformConnector = typeof platformConnectors.$inferInsert;

/**
 * Tools exposed by a platform connector (M09). Empty shell in Migration 0.
 */
export const platformConnectorTools = pgTable(
  'platform_connector_tools',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectorTools', 16))
      .primaryKey()
      .notNull(),

    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    toolKey: varchar('tool_key', { length: 128 }).notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull().default({}),
    permissionPolicy: varchar('permission_policy', { length: 32 })
      .notNull()
      .default('needs_approval'),
    allowUserStricterPolicy: boolean('allow_user_stricter_policy').notNull().default(true),
    limitConfig: jsonb('limit_config').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_connector_tools_connector_id_tool_key_unique').on(
      t.connectorId,
      t.toolKey,
    ),
    index('platform_connector_tools_connector_id_idx').on(t.connectorId),
  ],
);

export type PlatformConnectorToolItem = typeof platformConnectorTools.$inferSelect;
export type NewPlatformConnectorTool = typeof platformConnectorTools.$inferInsert;

/**
 * Per-user OAuth / token bindings for platform connectors (M09). Empty shell in Migration 0.
 */
export const platformUserConnectorBindings = pgTable(
  'platform_user_connector_bindings',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformUserConnectorBindings', 16))
      .primaryKey()
      .notNull(),

    userId: text('user_id').notNull(),
    connectorId: text('connector_id')
      .notNull()
      .references(() => platformConnectors.id, { onDelete: 'restrict' }),
    authStatus: varchar('auth_status', { length: 32 }).notNull().default('disconnected'),
    encryptedCredentials: text('encrypted_credentials'),
    expiresAt: timestamptz('expires_at'),
    lastError: text('last_error'),
    connectedAt: timestamptz('connected_at'),
    status: varchar('status', { length: 32 }).notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_user_connector_bindings_user_connector_unique').on(
      t.userId,
      t.connectorId,
    ),
    index('platform_user_connector_bindings_user_id_idx').on(t.userId),
    index('platform_user_connector_bindings_connector_id_idx').on(t.connectorId),
    index('platform_user_connector_bindings_status_idx').on(t.status),
  ],
);

export type PlatformUserConnectorBindingItem = typeof platformUserConnectorBindings.$inferSelect;
export type NewPlatformUserConnectorBinding = typeof platformUserConnectorBindings.$inferInsert;
