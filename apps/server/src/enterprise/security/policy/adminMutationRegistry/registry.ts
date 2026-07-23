import { ADMIN_MUTATION_ENTRIES_AUDIT_CONNECTORS } from './entries.auditConnectors';
import { ADMIN_MUTATION_ENTRIES_CATALOG } from './entries.catalog';
import { ADMIN_MUTATION_ENTRIES_IDENTITY_ACCESS } from './entries.identityAccess';
import { ADMIN_MUTATION_ENTRIES_PLATFORM } from './entries.platform';
import type { AdminMutationDefinition } from './types';

/**
 * Risk and control matrix for every admin mutation.
 * Split by domain under this folder; combined here for reconciliation.
 */
export const ADMIN_MUTATION_REGISTRY = {
  ...ADMIN_MUTATION_ENTRIES_CATALOG,
  ...ADMIN_MUTATION_ENTRIES_AUDIT_CONNECTORS,
  ...ADMIN_MUTATION_ENTRIES_IDENTITY_ACCESS,
  ...ADMIN_MUTATION_ENTRIES_PLATFORM,
} as const satisfies Record<`admin.${string}`, AdminMutationDefinition>;

export type AdminMutationProcedure = keyof typeof ADMIN_MUTATION_REGISTRY;
