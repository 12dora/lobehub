import type { PUBLICATION_POINTER_SOURCES } from '../inventory';
import { digestCanonicalRecords, sha256Hex } from './invariants.digest';
import type { BooleanInvariant } from './invariants.types';

/**
 * Domain rule for `platform_resource_revisions` publication pointers
 * (connectors, bindings, oidc activation, branding:published):
 * a current published/activation pointer must resolve to a target whose
 * `status` is exactly this value. Archived/draft/other statuses are mismatches.
 */
export const RESOURCE_REVISION_PUBLISHED_STATUS = 'published' as const;

export type PublicationPointerSource = (typeof PUBLICATION_POINTER_SOURCES)[number];

export type ResourceRevisionPointerSource = Extract<
  PublicationPointerSource,
  { kind: 'resource-revision' }
>;

export type FixedHolderRevisionPointerSource = Extract<
  PublicationPointerSource,
  { kind: 'fixed-holder-revision' }
>;

export type DomainVersionPointerSource = Extract<
  PublicationPointerSource,
  { kind: 'domain-version' }
>;

export interface ResourceRevisionTargetRow {
  checksum: string;
  resource_id: string;
  resource_type: string;
  revision: string;
  status: string;
}

/**
 * Shared outcome for one publication-pointer invariant.
 * Failures keep records collected before the finding so the pointer digest
 * matches the original fail-closed early return.
 */
export type PointerCheckPass = {
  match: true;
  records: Record<string, unknown>[];
  /** Remaining checks for this source are skipped (absent column or pre-publish). */
  skipSource?: true;
};

export type PointerCheckFail = {
  match: false;
  detail: string;
  /**
   * Missing pointer table hashes empty bytes rather than accumulated records.
   * Every other finding canonicalizes records collected so far.
   */
  emptyDigest?: true;
  records: Record<string, unknown>[];
};

export type PointerCheckResult = PointerCheckPass | PointerCheckFail;

export const collectPointerChecks = async (
  checks: ReadonlyArray<() => PointerCheckResult | Promise<PointerCheckResult>>,
): Promise<PointerCheckResult> => {
  const records: Record<string, unknown>[] = [];
  for (const check of checks) {
    const result = await check();
    if (!result.match) {
      return {
        detail: result.detail,
        match: false,
        records: [...records, ...result.records],
        ...(result.emptyDigest ? { emptyDigest: true as const } : {}),
      };
    }
    records.push(...result.records);
    if (result.skipSource) {
      return { match: true, records, skipSource: true };
    }
  }
  return { match: true, records };
};

export const toPublicationPointerFailure = (
  finding: PointerCheckFail,
  priorRecords: Record<string, unknown>[],
): BooleanInvariant & { pointerDigest: string } => ({
  detail: finding.detail,
  match: false,
  pointerDigest: finding.emptyDigest
    ? sha256Hex('')
    : digestCanonicalRecords('publication-pointers', [...priorRecords, ...finding.records]),
});
