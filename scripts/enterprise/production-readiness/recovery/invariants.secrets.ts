import type { PoolClient } from 'pg';

import { digestCanonicalRecords, sha256Hex } from './invariants.digest';

export const verifySecretReferenceDomains = async (
  client: PoolClient,
): Promise<{
  aggregateDigest: string;
  dangling: boolean;
  match: boolean;
  domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }>;
}> => {
  const secretRecords: Record<string, unknown>[] = [];
  let dangling = false;
  let match = true;
  const domains: Record<string, { historyCount: number; referenceCount: number; match: boolean }> =
    {};

  const idp = await client.query<{ fingerprint: string | null; id: string; ref: string | null }>(
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
    secretRecords.push({
      domain: 'idp',
      fingerprint: provider.fingerprint,
      id: provider.id,
      ref_digest: provider.ref ? sha256Hex(provider.ref) : null,
    });
    if (provider.ref || provider.fingerprint) {
      const history = idph.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) identityMatch = false;
      for (const h of history) {
        if (provider.fingerprint && h.fingerprint !== provider.fingerprint) identityMatch = false;
        if (provider.ref && h.ref !== provider.ref) identityMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          domain: 'idph',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
          provider_id: h.provider_id,
          ref_digest: sha256Hex(h.ref),
        });
      }
    }
  }
  domains.identity = {
    historyCount: idph.rows.length,
    match: identityMatch,
    referenceCount: idp.rows.filter((r) => r.ref).length,
  };
  if (!identityMatch) match = false;

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
  let aiDomainDangling = false;
  if (Number(aiDangling.rows[0]?.n ?? 0) > 0) {
    dangling = true;
    aiDomainDangling = true;
    match = false;
  }
  // The aggregate dangling flag may include an earlier domain; AI matching uses only AI orphans.
  let aiMatch = !aiDomainDangling;
  for (const provider of aip.rows) {
    secretRecords.push({
      domain: 'ai',
      fingerprint: provider.fingerprint,
      id: provider.id,
      key_id_digest: provider.key_id ? sha256Hex(provider.key_id) : null,
    });
    if (provider.fingerprint) {
      const history = aih.rows.filter((row) => row.provider_id === provider.id);
      if (history.length < 1) aiMatch = false;
      for (const h of history) {
        if (h.fingerprint !== provider.fingerprint) aiMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          domain: 'aih',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
          provider_id: h.provider_id,
        });
      }
    }
  }
  domains.ai = {
    historyCount: aih.rows.length,
    match: aiMatch,
    referenceCount: aip.rows.filter((r) => r.fingerprint).length,
  };
  if (!aiMatch) match = false;

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
    secretRecords.push({
      domain: 'connector',
      id: c.id,
      oauth_fp: c.oauth_fp,
      oauth_ref_digest: c.oauth_ref ? sha256Hex(c.oauth_ref) : null,
      shared_fp: c.shared_fp,
      shared_ref_digest: c.shared_ref ? sha256Hex(c.shared_ref) : null,
    });
    const fps = [c.shared_fp, c.oauth_fp].filter(Boolean) as string[];
    if (fps.length > 0) {
      const history = conh.rows.filter((row) => row.connector_id === c.id);
      if (history.length < 1) connectorMatch = false;
      for (const h of history) {
        if (!fps.includes(h.fingerprint)) connectorMatch = false;
        secretRecords.push({
          ciphertext_digest: sha256Hex(h.ciphertext),
          connector_id: h.connector_id,
          domain: 'connector-history',
          fingerprint: h.fingerprint,
          id: h.id,
          key_id_digest: sha256Hex(h.key_id),
        });
      }
    }
  }
  for (const h of conh.rows) {
    if (!h.connector_id) {
      connectorMatch = false;
      continue;
    }
    const owner = conn.rows.find((c) => c.id === h.connector_id);
    if (!owner) {
      connectorMatch = false;
      dangling = true;
    }
  }
  domains.connectors = {
    historyCount: conh.rows.length,
    match: connectorMatch,
    referenceCount: conn.rows.filter((c) => c.shared_ref || c.oauth_ref).length,
  };
  if (!connectorMatch) match = false;

  return {
    aggregateDigest: digestCanonicalRecords('secret-domains', secretRecords),
    dangling,
    domains,
    match: match && !dangling,
  };
};
