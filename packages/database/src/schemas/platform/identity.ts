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
import { createdAt, updatedAt } from '../_helpers';

/**
 * Identity provider lifecycle (M11). Includes pending_restart / active / error beyond base status.
 */
export type PlatformIdentityProviderStatus =
  'draft' | 'published' | 'pending_restart' | 'active' | 'error' | 'disabled' | 'archived';

/**
 * External login OIDC providers (M11). Empty shell in Migration 0.
 * Client secret is envelope-encrypted; never stored in revision payloads.
 */
export const platformIdentityProviders = pgTable(
  'platform_identity_providers',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformIdentityProviders', 16))
      .primaryKey()
      .notNull(),

    providerKey: varchar('provider_key', { length: 128 }).notNull(),
    type: varchar('type', { length: 32 }).notNull().default('oidc'),
    displayName: text('display_name').notNull(),
    buttonLabel: text('button_label'),
    icon: text('icon'),
    issuer: text('issuer'),
    discoveryUrl: text('discovery_url'),
    clientId: text('client_id'),
    encryptedClientSecret: text('encrypted_client_secret'),
    secretFingerprint: text('secret_fingerprint'),
    scopes: text('scopes'),
    usePkce: boolean('use_pkce').notNull().default(true),
    claimMapping: jsonb('claim_mapping').$type<Record<string, unknown>>().default({}),
    domainAllowlist: jsonb('domain_allowlist').$type<string[]>().default([]),
    autoProvision: boolean('auto_provision').notNull().default(true),
    groupRoleMapping: jsonb('group_role_mapping').$type<Record<string, unknown>>().default({}),
    status: varchar('status', { length: 32 })
      .$type<PlatformIdentityProviderStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_identity_providers_provider_key_unique').on(t.providerKey),
    index('platform_identity_providers_status_idx').on(t.status),
  ],
);

export type PlatformIdentityProviderItem = typeof platformIdentityProviders.$inferSelect;
export type NewPlatformIdentityProvider = typeof platformIdentityProviders.$inferInsert;
