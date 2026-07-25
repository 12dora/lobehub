/**
 * Platform agent catalog repository (DB-005 split by transactional aggregate).
 *
 * - `types.ts` — shared types + advisory lock helpers
 * - `identity.ts` — identity / version CAS
 * - `assignment.ts` — assignments / rollout fan-out
 * - `materialization.ts` — materialization / tombstones / visibility
 *
 * Public surface is unchanged: `PlatformAgentCatalogRepository`.
 */
import { PlatformAgentMaterializationRepository } from './materialization';

export { PlatformAgentAssignmentRepository } from './assignment';
export { PlatformAgentIdentityRepository } from './identity';
export { PlatformAgentMaterializationRepository } from './materialization';
export type {
  ExactPlatformAgentVersion,
  PlatformAgentAssignmentPage,
  PlatformAgentAssignmentSafeItem,
  PlatformAgentAssignmentTargetPage,
  PlatformAgentAssignmentWrite,
  PlatformAgentDraftPatch,
  PlatformAgentEffectiveInput,
  PlatformAgentIdentityPage,
  PlatformAgentMaterializationDependentPage,
  PlatformAgentRolloutMaterializationInput,
  PlatformAgentRolloutMaterializationResult,
  PlatformAgentVersionPage,
} from './types';
export { acquirePlatformAgentReferenceLock, PlatformAgentMaterializationRaceError } from './types';

/** Facade class name retained for all existing import sites. */
export class PlatformAgentCatalogRepository extends PlatformAgentMaterializationRepository {}
