/**
 * Platform skill catalog public surface.
 *
 * Implementation is split for cohesion:
 * - skillCanonicalize.ts — canonicalize / checksum / snapshot parse / views
 * - skillCatalog.model.ts — PlatformSkillCatalogModel aggregate
 * - skillCatalog.pointer.ts — revision pointer adapter
 */

export {
  canonicalizePlatformSkillContent,
  canonicalizePlatformSkillManifest,
  canonicalizePlatformSkillResources,
  draftView,
  parsePlatformPublishedSkillSnapshot,
  type PlatformPublishedSkillPageView,
  type PlatformPublishedSkillView,
  PlatformSkillBuiltinOverrideError,
  type PlatformSkillCatalogTokenEntryView,
  PlatformSkillChecksumMismatchError,
  type PlatformSkillDetailView,
  platformSkillDraftToken,
  type PlatformSkillDraftView,
  platformSkillVersionChecksum,
  type PlatformSkillVersionView,
} from './skillCanonicalize';
export { PlatformSkillCatalogModel } from './skillCatalog.model';
export {
  createPlatformSkillPointerAdapter,
  type PlatformSkillPointerAdapterParams,
} from './skillCatalog.pointer';
