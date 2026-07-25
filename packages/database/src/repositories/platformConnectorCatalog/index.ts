/**
 * Platform connector catalog (DB-005 split by transactional aggregate).
 *
 * - types.ts — shared types
 * - catalog.ts — connector drafts / revisions / tools / admin revoke-all
 * - oauthState.ts — OAuth state reservation CAS
 * - bindings.ts — user binding lifecycle / OAuth finalization
 */
export { PlatformUserConnectorBindingRepository } from './bindings';
export { PlatformConnectorCatalogRepository } from './catalog';
export { PlatformConnectorOAuthStateRepository } from './oauthState';
export * from './types';
