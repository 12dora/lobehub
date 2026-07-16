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

export interface PlatformAiProviderConfig {
  apiStyle?: string;
  endpoint?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface PlatformAiProviderSettings {
  proxyUrl?: string;
  responseAnimation?: string;
  sdkType?: string;
}

export interface PlatformAiModelAbilities {
  files?: boolean;
  functionCall?: boolean;
  imageOutput?: boolean;
  reasoning?: boolean;
  search?: boolean;
  vision?: boolean;
}

export interface PlatformAiModelConfig {
  deploymentName?: string;
  organization?: string;
}

export interface PlatformAiModelParameters {
  frequencyPenalty?: number;
  maxTokens?: number;
  presencePenalty?: number;
  temperature?: number;
  topP?: number;
}

export interface PlatformAiModelPricing {
  cachedInput?: number;
  currency?: string;
  input?: number;
  output?: number;
  unit?: string;
}

export interface PlatformAiModelSettings {
  extendParams?: string[];
  searchImpl?: string;
}

/**
 * Global AI Provider definitions (M07). Empty shell in Migration 0.
 * Secrets live in encrypted_key_vaults; API responses expose only fingerprint metadata.
 */
export const platformAiProviders = pgTable(
  'platform_ai_providers',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAiProviders', 16))
      .primaryKey()
      .notNull(),

    providerKey: varchar('provider_key', { length: 64 }).notNull(),
    displayName: text('display_name').notNull(),
    description: text('description'),
    logo: text('logo'),
    source: varchar('source', { length: 32 }).notNull().default('custom'),
    enabled: boolean('enabled').notNull().default(false),
    fetchOnClient: boolean('fetch_on_client').notNull().default(false),
    checkModel: text('check_model'),
    settings: jsonb('settings').$type<PlatformAiProviderSettings>().notNull().default({}),
    config: jsonb('config').$type<PlatformAiProviderConfig>().notNull().default({}),
    /** Envelope-encrypted credentials; never returned via API. */
    encryptedKeyVaults: text('encrypted_key_vaults'),
    secretKeyVersion: integer('secret_key_version'),
    secretUpdatedAt: timestamptz('secret_updated_at'),
    secretFingerprint: text('secret_fingerprint'),
    sort: integer('sort').notNull().default(0),
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
    uniqueIndex('platform_ai_providers_provider_key_unique').on(t.providerKey),
    index('platform_ai_providers_status_idx').on(t.status),
    index('platform_ai_providers_enabled_sort_idx').on(t.enabled, t.sort),
  ],
);

export type PlatformAiProviderItem = typeof platformAiProviders.$inferSelect;
export type NewPlatformAiProvider = typeof platformAiProviders.$inferInsert;

/**
 * Models under a platform provider (M07). Empty shell in Migration 0.
 */
export const platformAiModels = pgTable(
  'platform_ai_models',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformAiModels', 16))
      .primaryKey()
      .notNull(),

    providerId: text('provider_id')
      .notNull()
      .references(() => platformAiProviders.id, { onDelete: 'restrict' }),
    modelKey: varchar('model_key', { length: 150 }).notNull(),
    displayName: varchar('display_name', { length: 200 }),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    type: varchar('type', { length: 20 }).notNull().default('chat'),
    sort: integer('sort').notNull().default(0),
    pricing: jsonb('pricing').$type<PlatformAiModelPricing>(),
    parameters: jsonb('parameters').$type<PlatformAiModelParameters>().default({}),
    config: jsonb('config').$type<PlatformAiModelConfig>(),
    abilities: jsonb('abilities').$type<PlatformAiModelAbilities>().default({}),
    contextWindowTokens: integer('context_window_tokens'),
    settings: jsonb('settings').$type<PlatformAiModelSettings>().default({}),
    status: varchar('status', { length: 32 })
      .$type<PlatformResourceStatus>()
      .notNull()
      .default('draft'),
    revision: integer('revision').notNull().default(0),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    publishedAt: timestamptz('published_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_ai_models_provider_id_model_key_unique').on(t.providerId, t.modelKey),
    index('platform_ai_models_enabled_sort_idx').on(t.enabled, t.sort),
    index('platform_ai_models_status_idx').on(t.status),
    index('platform_ai_models_provider_id_idx').on(t.providerId),
  ],
);

export type PlatformAiModelItem = typeof platformAiModels.$inferSelect;
export type NewPlatformAiModel = typeof platformAiModels.$inferInsert;
