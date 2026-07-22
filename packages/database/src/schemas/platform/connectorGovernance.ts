import { integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import type { PlatformConnectorGovernanceConfig } from '@/types/platform/connectorGovernance';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, updatedAt } from '../_helpers';

/**
 * Org-wide connector governance document (single logical row).
 * `resource` is the stable identity `governance:connectors`; the config JSONB
 * carries the draft/published `ConnectorGovernanceDoc` pair. Runtime only ever
 * reads `config.published`.
 */
export const platformConnectorGovernance = pgTable(
  'platform_connector_governance',
  {
    id: text('id')
      .$defaultFn(() => idGenerator('platformConnectorGovernance', 16))
      .primaryKey()
      .notNull(),

    /** Stable resource identity, always `governance:connectors`. */
    resource: text('resource').notNull(),
    config: jsonb('config')
      .$type<PlatformConnectorGovernanceConfig>()
      .notNull()
      // Model normalization closes legacy `{}` rows to the empty governance doc.
      .default({} as PlatformConnectorGovernanceConfig),
    revision: integer('revision').notNull().default(0),
    updatedBy: text('updated_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('platform_connector_governance_resource_unique').on(t.resource)],
);

export type PlatformConnectorGovernanceItem = typeof platformConnectorGovernance.$inferSelect;
export type NewPlatformConnectorGovernance = typeof platformConnectorGovernance.$inferInsert;
