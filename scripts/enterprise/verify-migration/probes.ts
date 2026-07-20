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
  secretHistoryId: 'pids_m15q03_probe_01',
} as const;

/** Opaque KMS-style handle — never real ciphertext material. */
export const PROBE_SECRET_REF = 'kms://platform-identity-providers/m15q03-probe' as const;

/** 64-char lowercase hex fingerprint (not secret material). */
export const PROBE_SECRET_FINGERPRINT = createHash('sha256')
  .update('m15q03-probe-fingerprint-seed')
  .digest('hex');

export const PROBE_PAYLOAD_CHECKSUM = createHash('sha256')
  .update('{"displayName":"Migration Compat Probe"}')
  .digest('hex');

/** Placeholder envelope marker — not a live secret or private key. */
export const PROBE_SECRET_ENVELOPE_PLACEHOLDER = 'probe-envelope-placeholder-not-a-secret' as const;
export const PROBE_SECRET_KEY_ID = 'probe-key-id' as const;

/**
 * Production CHECK constraint names that secret-reference probes must observe.
 * FK name is verified separately (PostgreSQL truncates long identifier names to 63 chars).
 */
export const REQUIRED_IDENTITY_SECRET_CONSTRAINTS = [
  'platform_identity_providers_secret_state_check',
  'platform_identity_providers_secret_ref_check',
  'platform_identity_provider_secrets_ref_check',
  'platform_identity_provider_secrets_fingerprint_check',
  'platform_identity_provider_secrets_revision_check',
] as const;

export const buildPlatformProbeStatements = (): string[] => {
  const { auditId, identityId, revisionId, revisionId2, resourceId, secretHistoryId } =
    PLATFORM_PROBE_IDS;

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
    // Provider first (history FK targets provider_id).
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
    // Matching history row — opaque envelope placeholder only (no real secret).
    `INSERT INTO "platform_identity_provider_secrets"
      ("id", "provider_id", "fingerprint", "ref", "ciphertext", "key_id", "revision")
     VALUES
      ('${secretHistoryId}', '${identityId}', '${PROBE_SECRET_FINGERPRINT}',
       '${PROBE_SECRET_REF}', '${PROBE_SECRET_ENVELOPE_PLACEHOLDER}',
       '${PROBE_SECRET_KEY_ID}', 1)
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

const listPresentConstraintNames = async (client: PoolClient): Promise<Set<string>> => {
  const result = await client.query<{ conname: string }>(
    `SELECT c.conname
     FROM pg_constraint c
     JOIN pg_class rel ON rel.oid = c.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE nsp.nspname = 'public'
       AND rel.relname IN ('platform_identity_providers', 'platform_identity_provider_secrets')`,
  );
  return new Set(result.rows.map((row) => row.conname));
};

/**
 * Fail closed when production secret constraints are missing (e.g. DROP CONSTRAINT
 * false-green). Returns false if any required name is absent.
 */
export const verifyIdentitySecretConstraintsPresent = async (
  client: PoolClient,
): Promise<boolean> => {
  const present = await listPresentConstraintNames(client);
  if (!REQUIRED_IDENTITY_SECRET_CONSTRAINTS.every((name) => present.has(name))) {
    return false;
  }
  // FK: provider_id → platform_identity_providers(id). Name may be truncated to 63 chars.
  const fk = await client.query<{ conname: string }>(
    `SELECT c.conname
     FROM pg_constraint c
     JOIN pg_class rel ON rel.oid = c.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     JOIN pg_class frel ON frel.oid = c.confrelid
     WHERE c.contype = 'f'
       AND nsp.nspname = 'public'
       AND rel.relname = 'platform_identity_provider_secrets'
       AND frel.relname = 'platform_identity_providers'`,
  );
  return (fk.rowCount ?? 0) > 0;
};

/**
 * Actively exercise production CHECK/FK constraints. Every illegal mutation must
 * be rejected by the database. Returns false if any illegal mutation succeeds.
 */
export const attemptIllegalSecretMutations = async (client: PoolClient): Promise<boolean> => {
  const attempts: Array<() => Promise<void>> = [
    // Illegal provider secret_ref shape (secret_ref_check).
    async () => {
      await client.query(
        `UPDATE platform_identity_providers
         SET secret_ref = $1
         WHERE id = $2`,
        ['not-a-kms-ref', PLATFORM_PROBE_IDS.identityId],
      );
    },
    // Non-hex fingerprint with non-null ref (secret_state_check).
    // Note: NULL fingerprint is SQL-unknown under CHECK and is not rejected by PG;
    // production CHECK only fails non-matching non-null fingerprints.
    async () => {
      await client.query(
        `UPDATE platform_identity_providers
         SET secret_fingerprint = $1, secret_updated_at = now()
         WHERE id = $2`,
        ['not-a-hex-fingerprint', PLATFORM_PROBE_IDS.identityId],
      );
    },
    // Missing timestamp with non-null ref/fingerprint (secret_state_check).
    async () => {
      await client.query(
        `UPDATE platform_identity_providers
         SET secret_updated_at = NULL
         WHERE id = $1`,
        [PLATFORM_PROBE_IDS.identityId],
      );
    },
    // History row with illegal ref (secrets_ref_check).
    async () => {
      await client.query(
        `INSERT INTO platform_identity_provider_secrets
          (id, provider_id, fingerprint, ref, ciphertext, key_id, revision)
         VALUES ($1, $2, $3, $4, $5, $6, 2)`,
        [
          `pids_m15q03_illegal_ref_${Date.now()}`,
          PLATFORM_PROBE_IDS.identityId,
          createHash('sha256').update('illegal-ref').digest('hex'),
          'plaintext-not-kms',
          PROBE_SECRET_ENVELOPE_PLACEHOLDER,
          PROBE_SECRET_KEY_ID,
        ],
      );
    },
    // History row with invalid fingerprint (secrets_fingerprint_check).
    async () => {
      await client.query(
        `INSERT INTO platform_identity_provider_secrets
          (id, provider_id, fingerprint, ref, ciphertext, key_id, revision)
         VALUES ($1, $2, $3, $4, $5, $6, 2)`,
        [
          `pids_m15q03_illegal_fp_${Date.now()}`,
          PLATFORM_PROBE_IDS.identityId,
          'not-hex-fingerprint',
          `${PROBE_SECRET_REF}-illegal-fp`,
          PROBE_SECRET_ENVELOPE_PLACEHOLDER,
          PROBE_SECRET_KEY_ID,
        ],
      );
    },
    // History row with invalid provider FK.
    async () => {
      await client.query(
        `INSERT INTO platform_identity_provider_secrets
          (id, provider_id, fingerprint, ref, ciphertext, key_id, revision)
         VALUES ($1, $2, $3, $4, $5, $6, 1)`,
        [
          `pids_m15q03_illegal_fk_${Date.now()}`,
          'pidp_does_not_exist',
          createHash('sha256').update('illegal-fk').digest('hex'),
          `${PROBE_SECRET_REF}-orphan`,
          PROBE_SECRET_ENVELOPE_PLACEHOLDER,
          PROBE_SECRET_KEY_ID,
        ],
      );
    },
  ];

  for (const attempt of attempts) {
    try {
      await attempt();
      // If we get here, the database accepted illegal data → fail the probe.
      return false;
    } catch {
      // expected rejection
    }
  }
  return true;
};

/**
 * Secret-reference: require provider/history consistency under production constraints.
 * Zero matching history rows is failure. Constraint drops fail closed.
 */
export const verifySecretReferenceProbes = async (
  client: PoolClient,
): Promise<ProbeInvariantResult> => {
  if (!(await verifyIdentitySecretConstraintsPresent(client))) {
    return { match: false, rowCount: 0 };
  }

  const provider = await client.query<{
    encrypted_client_secret: string | null;
    secret_fingerprint: string | null;
    secret_ref: string | null;
    secret_updated_at: Date | null;
  }>(
    `SELECT secret_ref, secret_fingerprint, secret_updated_at, encrypted_client_secret
     FROM platform_identity_providers
     WHERE id = $1`,
    [PLATFORM_PROBE_IDS.identityId],
  );
  if (provider.rows.length < 1) return { match: false, rowCount: 0 };

  const row = provider.rows[0]!;
  if (row.secret_ref !== PROBE_SECRET_REF) return { match: false, rowCount: 0 };
  if (row.secret_fingerprint !== PROBE_SECRET_FINGERPRINT) return { match: false, rowCount: 0 };
  if (!row.secret_updated_at) return { match: false, rowCount: 0 };
  if (!/^[a-f0-9]{64}$/.test(row.secret_fingerprint ?? '')) return { match: false, rowCount: 0 };
  if (!row.secret_ref?.startsWith('kms://platform-identity-providers/')) {
    return { match: false, rowCount: 0 };
  }
  if (row.encrypted_client_secret !== null) return { match: false, rowCount: 0 };

  // Provider must join exactly one matching history row (ref + fingerprint + provider_id).
  const history = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM platform_identity_provider_secrets s
     JOIN platform_identity_providers p ON p.id = s.provider_id
     WHERE p.id = $1
       AND s.ref = p.secret_ref
       AND s.fingerprint = p.secret_fingerprint
       AND s.ref = $2
       AND s.fingerprint = $3
       AND s.ciphertext = $4`,
    [
      PLATFORM_PROBE_IDS.identityId,
      PROBE_SECRET_REF,
      PROBE_SECRET_FINGERPRINT,
      PROBE_SECRET_ENVELOPE_PLACEHOLDER,
    ],
  );
  const rowCount = Number(history.rows[0]?.count ?? 0);
  if (rowCount < 1) return { match: false, rowCount };

  // No dangling provider secret_ref without history.
  const orphan = await client.query(
    `SELECT 1 FROM platform_identity_providers p
     WHERE p.secret_ref IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM platform_identity_provider_secrets s
         WHERE s.provider_id = p.id
           AND s.ref = p.secret_ref
           AND s.fingerprint = p.secret_fingerprint
       )
     LIMIT 1`,
  );
  if (orphan.rowCount && orphan.rowCount > 0) return { match: false, rowCount };

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

  if (!(await attemptIllegalSecretMutations(client))) {
    return { match: false, rowCount };
  }

  return { match: true, rowCount };
};
