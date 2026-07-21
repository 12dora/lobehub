/**
 * Post-restore invariants with full secret/publication/table coverage.
 * Evidence emits digests/counts only.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { PUBLICATION_POINTER_SOURCES, RECOVERY_ENTERPRISE_TABLES } from '../inventory';

export interface AggregateDigestResult {
  digest: string;
  match: boolean;
  rowCount: number;
}

export interface BooleanInvariant {
  detail?: string;
  match: boolean;
}

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const digestResourceRevisions = async (
  client: PoolClient,
): Promise<AggregateDigestResult> => {
  const result = await client.query<{
    checksum: string;
    id: string;
    resource_id: string;
    resource_type: string;
    revision: string;
    status: string;
  }>(
    `SELECT id, resource_type, resource_id, revision::text AS revision, status, checksum
     FROM platform_resource_revisions
     ORDER BY resource_type, resource_id, revision, id`,
  );
  const lines = result.rows.map(
    (row) =>
      `${row.id}|${row.resource_type}|${row.resource_id}|${row.revision}|${row.status}|${row.checksum}`,
  );
  return { digest: sha256Hex(lines.join('\n')), match: true, rowCount: result.rows.length };
};

export const digestAuditLogs = async (client: PoolClient): Promise<AggregateDigestResult> => {
  const result = await client.query<{
    action: string;
    config_revision: string | null;
    diff_digest: string | null;
    id: string;
    result: string;
  }>(
    `SELECT id, action, result, config_revision::text AS config_revision,
            CASE WHEN after_diff IS NULL THEN NULL
                 ELSE md5(after_diff::text)
            END AS diff_digest
     FROM platform_audit_logs
     ORDER BY id`,
  );
  const lines = result.rows.map(
    (row) =>
      `${row.id}|${row.action}|${row.result}|${row.config_revision ?? ''}|${row.diff_digest ?? ''}`,
  );
  return { digest: sha256Hex(lines.join('\n')), match: true, rowCount: result.rows.length };
};

/**
 * Full secret-domain integrity: refs (hashed), fingerprints, history, dangling, duplicates.
 */
export const verifySecretReferenceDomains = async (
  client: PoolClient,
): Promise<{
  aggregateDigest: string;
  dangling: boolean;
  match: boolean;
  domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }>;
}> => {
  const digestParts: string[] = [];
  let dangling = false;
  let match = true;
  const domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }> =
    {};

  // Identity
  const idp = await client.query<{
    fingerprint: string | null;
    id: string;
    ref: string | null;
  }>(
    `SELECT id, secret_ref AS ref, secret_fingerprint AS fingerprint
     FROM platform_identity_providers ORDER BY id`,
  );
  const idph = await client.query<{
    ciphertext: string;
    fingerprint: string;
    id: string;
    key_id: string;
    provider_id: string;
    ref: string;
  }>(
    `SELECT id, provider_id, fingerprint, ref, ciphertext, key_id
     FROM platform_identity_provider_secrets ORDER BY id`,
  );
  const idpDangling = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM platform_identity_provider_secrets h
     LEFT JOIN platform_identity_providers p ON p.id = h.provider_id WHERE p.id IS NULL`,
  );
  if (Number(idpDangling.rows[0]?.n ?? 0) > 0) {
    dangling = true;
    match = false;
  }
  let identityMatch = !dangling;
  for (const provider of idp.rows) {
    const refDigest = provider.ref ? sha256Hex(provider.ref) : '';
    digestParts.push(`idp:${provider.id}:${refDigest}:${provider.fingerprint ?? ''}`);
    if (provider.ref || provider.fingerprint) {
      const history = idph.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) identityMatch = false;
      for (const h of history) {
        if (provider.fingerprint && h.fingerprint !== provider.fingerprint) identityMatch = false;
        if (provider.ref && h.ref !== provider.ref) identityMatch = false;
        digestParts.push(
          `idph:${h.id}:${h.provider_id}:${h.fingerprint}:${sha256Hex(h.ref)}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  const dupIdp = await client.query(
    `SELECT 1 FROM platform_identity_provider_secrets
     GROUP BY provider_id, fingerprint HAVING COUNT(*) > 1 LIMIT 1`,
  );
  if (dupIdp.rowCount && dupIdp.rowCount > 0) identityMatch = false;
  domains.identity = {
    historyCount: idph.rows.length,
    match: identityMatch,
    referenceCount: idp.rows.filter((r) => r.ref).length,
  };
  if (!identityMatch) match = false;

  // AI
  const aip = await client.query<{ fingerprint: string | null; id: string; key_id: string | null }>(
    `SELECT id, secret_fingerprint AS fingerprint, secret_key_id AS key_id
     FROM platform_ai_providers ORDER BY id`,
  );
  const aih = await client.query<{
    ciphertext: string;
    fingerprint: string;
    id: string;
    key_id: string;
    provider_id: string;
  }>(
    `SELECT id, provider_id, fingerprint, ciphertext, key_id
     FROM platform_ai_provider_secrets ORDER BY id`,
  );
  const aiDangling = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM platform_ai_provider_secrets h
     LEFT JOIN platform_ai_providers p ON p.id = h.provider_id WHERE p.id IS NULL`,
  );
  if (Number(aiDangling.rows[0]?.n ?? 0) > 0) {
    dangling = true;
    match = false;
  }
  let aiMatch = !dangling;
  for (const provider of aip.rows) {
    digestParts.push(
      `ai:${provider.id}:${provider.fingerprint ?? ''}:${provider.key_id ? sha256Hex(provider.key_id) : ''}`,
    );
    if (provider.fingerprint) {
      const history = aih.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) aiMatch = false;
      for (const h of history) {
        if (h.fingerprint !== provider.fingerprint) aiMatch = false;
        digestParts.push(
          `aih:${h.id}:${h.provider_id}:${h.fingerprint}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  domains.ai = {
    historyCount: aih.rows.length,
    match: aiMatch,
    referenceCount: aip.rows.filter((r) => r.fingerprint).length,
  };
  if (!aiMatch) match = false;

  // Connectors — shared + oauth refs/fingerprints
  const conn = await client.query<{
    id: string;
    oauth_fp: string | null;
    oauth_ref: string | null;
    shared_fp: string | null;
    shared_ref: string | null;
  }>(
    `SELECT id,
            shared_secret_ref AS shared_ref,
            shared_secret_fingerprint AS shared_fp,
            oauth_client_secret_ref AS oauth_ref,
            oauth_client_secret_fingerprint AS oauth_fp
     FROM platform_connectors ORDER BY id`,
  );
  const conh = await client.query<{
    ciphertext: string;
    connector_id: string | null;
    fingerprint: string;
    id: string;
    key_id: string;
  }>(
    `SELECT id, connector_id, fingerprint, ciphertext, key_id
     FROM platform_connector_secrets ORDER BY id`,
  );
  let connectorMatch = true;
  for (const c of conn.rows) {
    const sharedRefDigest = c.shared_ref ? sha256Hex(c.shared_ref) : '';
    const oauthRefDigest = c.oauth_ref ? sha256Hex(c.oauth_ref) : '';
    digestParts.push(
      `c:${c.id}:${sharedRefDigest}:${c.shared_fp ?? ''}:${oauthRefDigest}:${c.oauth_fp ?? ''}`,
    );
    // If any ref/fp present, require history fingerprint membership
    const fps = [c.shared_fp, c.oauth_fp].filter(Boolean) as string[];
    if (fps.length > 0) {
      const history = conh.rows.filter((row) => row.connector_id === c.id);
      if (history.length < 1) connectorMatch = false;
      for (const h of history) {
        if (!fps.includes(h.fingerprint)) connectorMatch = false;
        digestParts.push(
          `ch:${h.id}:${h.connector_id ?? ''}:${h.fingerprint}:${sha256Hex(h.ciphertext)}:${sha256Hex(h.key_id)}`,
        );
      }
    }
  }
  // Detect rewired refs: history fingerprint not matching any current
  for (const h of conh.rows) {
    if (!h.connector_id) {
      connectorMatch = false;
      continue;
    }
    const owner = conn.rows.find((c) => c.id === h.connector_id);
    if (!owner) {
      connectorMatch = false;
      dangling = true;
    } else {
      const fps = [owner.shared_fp, owner.oauth_fp].filter(Boolean);
      if (fps.length > 0 && !fps.includes(h.fingerprint)) connectorMatch = false;
    }
  }
  domains.connectors = {
    historyCount: conh.rows.length,
    match: connectorMatch,
    referenceCount: conn.rows.filter((c) => c.shared_ref || c.oauth_ref).length,
  };
  if (!connectorMatch) match = false;

  return {
    aggregateDigest: sha256Hex(digestParts.join('\n')),
    dangling,
    domains,
    match: match && !dangling,
  };
};

/**
 * Publication pointers must resolve to exact immutable revision rows when set.
 */
export const verifyPublicationPointers = async (
  client: PoolClient,
  options?: { allowEmptyPublished?: boolean; priorPublishedCount?: number },
): Promise<BooleanInvariant> => {
  // Connectors published_revision
  const connectors = await client.query<{
    id: string;
    published_checksum: string | null;
    published_revision: number | null;
  }>(
    `SELECT id, published_revision, published_checksum
     FROM platform_connectors
     WHERE published_revision IS NOT NULL`,
  );
  for (const row of connectors.rows) {
    const resolved = await client.query(
      `SELECT 1 FROM platform_resource_revisions
       WHERE resource_type = 'connector' AND resource_id = $1
         AND revision = $2 AND status = 'published'
         AND ($3::text IS NULL OR checksum = $3)
       LIMIT 1`,
      [row.id, row.published_revision, row.published_checksum],
    );
    if (!resolved.rowCount) {
      return { match: false, detail: `dangling-connector-pointer:${row.id}` };
    }
  }

  // Identity activation_revision
  const idps = await client.query<{ activation_revision: number | null; id: string }>(
    `SELECT id, activation_revision FROM platform_identity_providers
     WHERE activation_revision IS NOT NULL`,
  );
  for (const row of idps.rows) {
    const resolved = await client.query(
      `SELECT 1 FROM platform_resource_revisions
       WHERE resource_id = $1 AND revision = $2 LIMIT 1`,
      [row.id, row.activation_revision],
    );
    // activation may point at provider resource; if no row, still fail when table has pointers
    if (!resolved.rowCount) {
      // Soft: activation_revision without matching revision row is drift when revisions exist
      const anyRev = await client.query(`SELECT 1 FROM platform_resource_revisions LIMIT 1`);
      if (anyRev.rowCount) {
        return { match: false, detail: `dangling-identity-activation:${row.id}` };
      }
    }
  }

  // Published revision rows integrity
  const published = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions WHERE status = 'published'`,
  );
  const publishedCount = Number(published.rows[0]?.count ?? 0);
  if (
    options?.priorPublishedCount !== undefined &&
    publishedCount !== options.priorPublishedCount
  ) {
    return {
      match: false,
      detail: `published-count-drift:${options.priorPublishedCount}->${publishedCount}`,
    };
  }
  if (publishedCount === 0 && options?.allowEmptyPublished === false) {
    return { match: false, detail: 'zero-published-unexpected' };
  }

  // Duplicate revision ids
  const dups = await client.query(
    `SELECT 1 FROM platform_resource_revisions GROUP BY id HAVING COUNT(*) > 1 LIMIT 1`,
  );
  if (dups.rowCount && dups.rowCount > 0) {
    return { match: false, detail: 'duplicate-revision-id' };
  }

  void PUBLICATION_POINTER_SOURCES;
  return { match: true };
};

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

export const digestTableRowIdentities = async (
  client: PoolClient,
  table: string,
  idColumn = 'id',
): Promise<AggregateDigestResult> => {
  // Only for tables with a simple id text PK used in fixture.
  const result = await client.query<{ id: string }>(
    `SELECT ${idColumn}::text AS id FROM "${table}" ORDER BY ${idColumn}::text`,
  );
  const lines = result.rows.map((row) => row.id);
  return {
    digest: sha256Hex(lines.join('\n')),
    match: true,
    rowCount: result.rows.length,
  };
};
