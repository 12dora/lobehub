import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

/**
 * Non-PII / non-secret platform probe rows used to make revision, audit, and
 * secret-reference checks non-vacuous after post-baseline migrations.
 */
export const PLATFORM_PROBE_IDS = {
  auditId: 'paud_m15q03_probe_01',
  identityId: 'pidp_m15q03_probe_01',
  revisionId: 'prev_m15q03_probe_01',
  revisionId2: 'prev_m15q03_probe_02',
  resourceId: 'm15q03-probe-resource',
} as const;

/** Opaque KMS-style handle — never real ciphertext. */
export const PROBE_SECRET_REF = 'kms://platform-identity-providers/m15q03-probe' as const;

/** 64-char lowercase hex fingerprint (not secret material). */
export const PROBE_SECRET_FINGERPRINT = createHash('sha256')
  .update('m15q03-probe-fingerprint-seed')
  .digest('hex');

export const PROBE_PAYLOAD_CHECKSUM = createHash('sha256')
  .update('{"displayName":"Migration Compat Probe"}')
  .digest('hex');

export const buildPlatformProbeStatements = (): string[] => {
  const { auditId, identityId, revisionId, revisionId2, resourceId } = PLATFORM_PROBE_IDS;

  return [
    `INSERT INTO "platform_resource_revisions"
      ("id", "resource_type", "resource_id", "revision", "status", "payload", "checksum", "secret_fingerprint")
     VALUES
      ('${revisionId}', 'branding', '${resourceId}', 1, 'draft',
       '{"displayName":"Migration Compat Probe"}'::jsonb, '${PROBE_PAYLOAD_CHECKSUM}',
       '${PROBE_SECRET_FINGERPRINT}'),
      ('${revisionId2}', 'branding', '${resourceId}', 2, 'published',
       '{"displayName":"Migration Compat Probe v2"}'::jsonb,
       '${createHash('sha256').update('{"displayName":"Migration Compat Probe v2"}').digest('hex')}',
       '${PROBE_SECRET_FINGERPRINT}')
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "platform_audit_logs"
      ("id", "action", "target_type", "target_id", "result", "after_diff", "config_revision")
     VALUES
      ('${auditId}', 'platform.migration.compat.probe', 'branding', '${resourceId}',
       'success', '{"revision":2,"redacted":true,"fields":["displayName"]}'::jsonb, 2)
     ON CONFLICT ("id") DO NOTHING`,
    `INSERT INTO "platform_identity_providers"
      ("id", "provider_key", "type", "display_name", "button_label",
       "secret_ref", "secret_fingerprint", "secret_updated_at",
       "scopes", "use_pkce", "status", "revision", "enabled", "migration_required")
     VALUES
      ('${identityId}', 'm15q03-probe-idp', 'generic_oidc', 'Migration Compat Probe IdP',
       'Probe Login',
       '${PROBE_SECRET_REF}', '${PROBE_SECRET_FINGERPRINT}', now(),
       '["openid","profile","email"]'::jsonb, true, 'draft', 1, false, false)
     ON CONFLICT ("id") DO NOTHING`,
  ];
};

export const seedPlatformProbes = async (client: PoolClient): Promise<void> => {
  for (const statement of buildPlatformProbeStatements()) {
    await client.query(statement);
  }
};

export interface ProbeInvariantResult {
  match: boolean;
  rowCount: number;
}

/**
 * Revision: require real rows, uniqueness on (type, id, revision), fingerprint present.
 * Zero rows is failure (vacuous-pass eliminated).
 */
export const verifyRevisionProbes = async (client: PoolClient): Promise<ProbeInvariantResult> => {
  const countResult = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM platform_resource_revisions
     WHERE resource_id = $1`,
    [PLATFORM_PROBE_IDS.resourceId],
  );
  const rowCount = Number(countResult.rows[0]?.count ?? 0);
  if (rowCount < 2) return { match: false, rowCount };

  const dup = await client.query(
    `SELECT 1 FROM platform_resource_revisions
     GROUP BY resource_type, resource_id, revision
     HAVING COUNT(*) > 1
     LIMIT 1`,
  );
  if (dup.rowCount && dup.rowCount > 0) return { match: false, rowCount };

  const fingerprint = await client.query(
    `SELECT 1 FROM platform_resource_revisions
     WHERE resource_id = $1
       AND secret_fingerprint = $2
       AND secret_fingerprint ~ '^[a-f0-9]{64}$'
     LIMIT 1`,
    [PLATFORM_PROBE_IDS.resourceId, PROBE_SECRET_FINGERPRINT],
  );
  if (!fingerprint.rowCount) return { match: false, rowCount };

  // Uniqueness is enforced: a conflicting insert must fail.
  try {
    await client.query(
      `INSERT INTO platform_resource_revisions
        (id, resource_type, resource_id, revision, status, payload, checksum)
       VALUES ($1, 'branding', $2, 1, 'draft', '{}'::jsonb, 'conflict-checksum')`,
      [`prev_m15q03_probe_conflict_${Date.now()}`, PLATFORM_PROBE_IDS.resourceId],
    );
    return { match: false, rowCount };
  } catch {
    // expected unique violation
  }

  return { match: true, rowCount };
};

/**
 * Audit: require a real row with safe redacted shape (no secret-like values).
 * Zero rows is failure.
 */
export const verifyAuditProbes = async (client: PoolClient): Promise<ProbeInvariantResult> => {
  const result = await client.query<{
    action: string;
    after_diff: Record<string, unknown> | null;
    result: string;
  }>(
    `SELECT action, result, after_diff
     FROM platform_audit_logs
     WHERE id = $1`,
    [PLATFORM_PROBE_IDS.auditId],
  );
  const rowCount = result.rows.length;
  if (rowCount < 1) return { match: false, rowCount };

  const row = result.rows[0]!;
  if (row.action !== 'platform.migration.compat.probe') return { match: false, rowCount };
  if (row.result !== 'success') return { match: false, rowCount };
  if (!row.after_diff || row.after_diff.redacted !== true) return { match: false, rowCount };

  const serialized = JSON.stringify(row.after_diff);
  if (
    /-----BEGIN|password\s*[:=]|postgres(?:ql)?:\/\/|(?:sk|pk|rk)[_-]live[_-]/iu.test(serialized)
  ) {
    return { match: false, rowCount };
  }

  return { match: true, rowCount };
};

/**
 * Secret-reference: require ref+fingerprint pairing and FK-valid identity row.
 * Reject raw password-looking values and non-null legacy ciphertext on probe.
 * Zero matching rows is failure.
 */
export const verifySecretReferenceProbes = async (
  client: PoolClient,
): Promise<ProbeInvariantResult> => {
  const result = await client.query<{
    encrypted_client_secret: string | null;
    secret_fingerprint: string | null;
    secret_ref: string | null;
  }>(
    `SELECT secret_ref, secret_fingerprint, encrypted_client_secret
     FROM platform_identity_providers
     WHERE id = $1`,
    [PLATFORM_PROBE_IDS.identityId],
  );
  const rowCount = result.rows.length;
  if (rowCount < 1) return { match: false, rowCount };

  const row = result.rows[0]!;
  if (row.secret_ref !== PROBE_SECRET_REF) return { match: false, rowCount };
  if (row.secret_fingerprint !== PROBE_SECRET_FINGERPRINT) return { match: false, rowCount };
  if (!/^[a-f0-9]{64}$/.test(row.secret_fingerprint ?? '')) return { match: false, rowCount };
  if (!row.secret_ref?.startsWith('kms://platform-identity-providers/')) {
    return { match: false, rowCount };
  }
  // Expand-only secret model: probe must not store legacy ciphertext.
  if (row.encrypted_client_secret !== null) return { match: false, rowCount };

  // Schema-level: no probe row may place raw secret patterns into secret_ref columns.
  const leak = await client.query(
    `SELECT 1 FROM platform_identity_providers
     WHERE secret_ref IS NOT NULL
       AND (
         secret_ref ~ '-----BEGIN'
         OR secret_ref ~* '(sk|pk|rk)[_-]live[_-]'
         OR secret_ref ~* 'postgres(ql)?://'
         OR secret_ref ~* 'password\\s*[:=]'
       )
     LIMIT 1`,
  );
  if (leak.rowCount && leak.rowCount > 0) return { match: false, rowCount };

  return { match: true, rowCount };
};
