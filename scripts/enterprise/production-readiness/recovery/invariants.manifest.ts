import type { PoolClient } from 'pg';

import { RECOVERY_ENTERPRISE_TABLES } from '../inventory';
import {
  digestAllRequiredTables,
  digestAuditLogs,
  digestResourceRevisions,
} from './invariants.digest';
import { verifyPublicationPointers } from './invariants.pointers';
import { verifySecretReferenceDomains } from './invariants.secrets';
import type { AggregateDigestResult, BooleanInvariant } from './invariants.types';

export const verifyRequiredTablesPresent = async (
  client: PoolClient,
  tables: readonly string[] = RECOVERY_ENTERPRISE_TABLES,
): Promise<BooleanInvariant> => {
  for (const table of tables) {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS exists`,
      [table],
    );
    if (!result.rows[0]?.exists) {
      return { match: false, detail: `missing-table:${table}` };
    }
  }
  return { match: true };
};

export const compareDigests = (
  before: AggregateDigestResult,
  after: AggregateDigestResult,
): boolean =>
  before.digest === after.digest && before.rowCount === after.rowCount && before.rowCount >= 0;

/**
 * Build a source-manifest style digest package for backup attestation.
 * Refuses to baseline corrupted publication pointers (fail closed).
 */
export const buildSourceManifestCore = async (client: PoolClient) => {
  const revisions = await digestResourceRevisions(client);
  const audits = await digestAuditLogs(client);
  const secrets = await verifySecretReferenceDomains(client);
  const tables = await digestAllRequiredTables(client);
  const publications = await verifyPublicationPointers(client);
  if (!publications.match) {
    throw new Error(
      `source-manifest-refuses-invalid-publications:${publications.detail ?? 'unknown'}`,
    );
  }
  if (!secrets.match) {
    // Typed failure reason from the existing return contract (no invented fields).
    const domainFailures = Object.entries(secrets.domains)
      .filter(([, domain]) => !domain.match)
      .map(([name]) => name);
    const reasons = [...(secrets.dangling ? (['dangling'] as const) : []), ...domainFailures];
    throw new Error(
      `source-manifest-refuses-invalid-secrets:${reasons.length > 0 ? reasons.join(',') : 'secret-domain-mismatch'}`,
    );
  }
  const published = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
  );
  return {
    audits: { digest: audits.digest, rowCount: audits.rowCount },
    pointerDigest: publications.pointerDigest,
    publishedCount: Number(published.rows[0]?.count ?? 0),
    revisions: { digest: revisions.digest, rowCount: revisions.rowCount },
    secrets: { aggregateDigest: secrets.aggregateDigest, match: secrets.match },
    tables,
  };
};
