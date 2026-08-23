import type { PoolClient } from 'pg';

import { PUBLICATION_POINTER_SOURCES } from '../inventory';
import { digestCanonicalRecords } from './invariants.digest';
import {
  checkPointerColumnPresent,
  checkPointerDigestDrift,
  checkPointerTablePresent,
  checkPublishedCountDrift,
} from './invariants.pointers.checks';
import { scanDomainVersionPointers } from './invariants.pointers.domainVersion';
import { scanFixedHolderRevisionPointers } from './invariants.pointers.fixedHolder';
import { scanResourceRevisionPointers } from './invariants.pointers.resourceRevision';
import type { PointerCheckResult, PublicationPointerSource } from './invariants.pointers.result';
import { collectPointerChecks, toPublicationPointerFailure } from './invariants.pointers.result';
import type { BooleanInvariant } from './invariants.types';

export { RESOURCE_REVISION_PUBLISHED_STATUS } from './invariants.pointers.result';

const scanPublicationPointerSource = async (
  client: PoolClient,
  source: PublicationPointerSource,
): Promise<PointerCheckResult> =>
  collectPointerChecks([
    () => checkPointerTablePresent(client, source.table),
    () => checkPointerColumnPresent(client, source.table, source.pointerColumn),
    () => {
      if (source.kind === 'resource-revision') {
        return scanResourceRevisionPointers(client, source);
      }
      if (source.kind === 'fixed-holder-revision') {
        return scanFixedHolderRevisionPointers(client, source);
      }
      return scanDomainVersionPointers(client, source);
    },
  ]);

/**
 * Publication pointers for every declared source domain.
 * Binds domain + holder id + resource owner id + type + revision/version + checksum
 * + canonical target digest. No delimiter concatenation.
 */
export const verifyPublicationPointers = async (
  client: PoolClient,
  options?: { priorPublishedCount?: number; priorPointerDigest?: string },
): Promise<BooleanInvariant & { pointerDigest: string }> => {
  const pointerRecords: Record<string, unknown>[] = [];

  for (const source of PUBLICATION_POINTER_SOURCES) {
    const result = await scanPublicationPointerSource(client, source);
    if (!result.match) {
      return toPublicationPointerFailure(result, pointerRecords);
    }
    pointerRecords.push(...result.records);
  }

  const pointerDigest = digestCanonicalRecords('publication-pointers', pointerRecords);
  const post = await collectPointerChecks([
    () => checkPointerDigestDrift(pointerDigest, options?.priorPointerDigest),
    () => checkPublishedCountDrift(client, options?.priorPublishedCount),
  ]);
  if (!post.match) {
    return { detail: post.detail, match: false, pointerDigest };
  }

  return { match: true, pointerDigest };
};
