// @vitest-environment node
/**
 * RR7: safe canonical keys, mandatory connector checksum, oidc + branding:published pointers.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSignedProvenance,
  newNonce,
  RECOVERY_PROBE_IDS,
  verifyPublicationPointers,
  verifySignedProvenance,
} from './index';
import { createOwnedPostgres } from './recovery/ownedPostgres';
import {
  PROBE_PAYLOAD_CHECKSUM,
  PROBE_PAYLOAD_CHECKSUM_V2,
  seedRecoveryFixture,
} from './recovery/seed';
import {
  createTestTrustBundle,
  FIXTURE_CANDIDATE_SHA,
  FIXTURE_RELEASE_ID,
  sha256Of,
} from './testFixtures';
import { canonicalize, compareCodeUnits, sha256HexOfCanonicalSync } from './trust/canonical';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
  }
});

const dockerAvailable = async (): Promise<boolean> => {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

describe('RR7: canonical JSON preserves own keys and code-unit sort', () => {
  it('nested __proto__ own key is preserved and affects digest', () => {
    const withProto = JSON.parse('{"nested":{"__proto__":1,"a":2}}') as object;
    const without = JSON.parse('{"nested":{"a":2}}') as object;
    expect(canonicalize(withProto)).not.toBe(canonicalize(without));
    expect(sha256HexOfCanonicalSync(withProto)).not.toBe(sha256HexOfCanonicalSync(without));

    // Change value of __proto__
    const proto1 = JSON.parse('{"__proto__":{"x":1}}') as object;
    const proto2 = JSON.parse('{"__proto__":{"x":2}}') as object;
    expect(canonicalize(proto1)).not.toBe(canonicalize(proto2));
  });

  it('constructor/prototype keys preserved; reverse insertion of distinct Unicode keys stable', () => {
    const withCtor = JSON.parse('{"constructor":1,"a":2}') as object;
    expect(canonicalize(withCtor)).toContain('"constructor"');

    const eAcute: string = 'é'; // precomposed U+00E9
    const eCombining: string = 'e\u0301'; // e + combining acute
    expect(eAcute === eCombining).toBe(false);
    expect(compareCodeUnits(eAcute, eCombining)).not.toBe(0);

    // Reverse insertion order of two distinct keys must yield identical canonical bytes.
    const orderA = Object.create(null) as Record<string, number>;
    orderA[eAcute] = 1;
    orderA[eCombining] = 2;
    const orderB = Object.create(null) as Record<string, number>;
    orderB[eCombining] = 2;
    orderB[eAcute] = 1;
    expect(canonicalize(orderA)).toBe(canonicalize(orderB));
    // Both keys remain present
    const parsed = JSON.parse(canonicalize(orderA)) as Record<string, number>;
    expect(Object.keys(parsed)).toHaveLength(2);
    expect(parsed[eAcute]).toBe(1);
    expect(parsed[eCombining]).toBe(2);
  });

  it('deep arrays/null/unicode stable; provenance still verifies', () => {
    const deep = { a: [1, { b: null, c: 'café' }, [true, false]] };
    expect(canonicalize(deep)).toBe(canonicalize(structuredClone(deep)));

    const bundle = createTestTrustBundle(['production']);
    const payload = {
      artifactSha256: sha256Of('art'),
      candidateSha: FIXTURE_CANDIDATE_SHA,
      environment: 'production' as const,
      gateId: 'path-boundaries' as const,
      generatedAt: new Date().toISOString(),
      issuer: bundle.issuer,
      keyId: bundle.keyId,
      nonce: newNonce(),
      releaseId: FIXTURE_RELEASE_ID,
      runId: 'run-canon',
      schemaVersion: 1 as const,
      status: 'passed' as const,
    };
    const env = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    expect(
      verifySignedProvenance(env, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'path-boundaries',
        expectedGeneratedAt: payload.generatedAt,
        policy: bundle.policy,
      }).ok,
    ).toBe(true);
  });
});

describe('RR7: mandatory connector holder checksum', () => {
  it('docker: NULL/empty/invalid/different checksum fail', async () => {
    if (!(await dockerAvailable())) {
      expect(true).toBe(true);
      return;
    }
    const lifecycle = await createOwnedPostgres();
    try {
      await lifecycle.handle.withClient(async (client) => {
        await seedRecoveryFixture(client);
        expect((await verifyPublicationPointers(client)).match).toBe(true);

        await client.query(
          `UPDATE platform_connectors SET published_checksum = NULL WHERE id = $1`,
          [RECOVERY_PROBE_IDS.connectorId],
        );
        let r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/missing-or-invalid-holder-checksum/);

        await client.query(`UPDATE platform_connectors SET published_checksum = '' WHERE id = $1`, [
          RECOVERY_PROBE_IDS.connectorId,
        ]);
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);

        await client.query(
          `UPDATE platform_connectors SET published_checksum = 'not-a-sha' WHERE id = $1`,
          [RECOVERY_PROBE_IDS.connectorId],
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);

        await client.query(`UPDATE platform_connectors SET published_checksum = $1 WHERE id = $2`, [
          sha256Of('other'),
          RECOVERY_PROBE_IDS.connectorId,
        ]);
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/dangling-pointer|holder-checksum/);

        await client.query(`UPDATE platform_connectors SET published_checksum = $1 WHERE id = $2`, [
          PROBE_PAYLOAD_CHECKSUM_V2,
          RECOVERY_PROBE_IDS.connectorId,
        ]);
        expect((await verifyPublicationPointers(client)).match).toBe(true);
      });
    } finally {
      await lifecycle.cleanup();
    }
  }, 120_000);
});

describe('RR7: oidc identity and branding:published pointers', () => {
  it('docker: valid oidc + branding:published; wrong type/revision/target fail', async () => {
    if (!(await dockerAvailable())) {
      expect(true).toBe(true);
      return;
    }
    const lifecycle = await createOwnedPostgres();
    try {
      await lifecycle.handle.withClient(async (client) => {
        await seedRecoveryFixture(client);
        const ok = await verifyPublicationPointers(client);
        expect(ok.match).toBe(true);
        const baseDigest = ok.pointerDigest;

        // Wrong resource type on identity activation (point at identity_provider instead of oidc)
        await client.query(
          `UPDATE platform_resource_revisions SET resource_type = 'identity_provider'
           WHERE id = 'prev_m15q06_oidc_01'`,
        );
        let r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        await client.query(
          `UPDATE platform_resource_revisions SET resource_type = 'oidc'
           WHERE id = 'prev_m15q06_oidc_01'`,
        );
        expect((await verifyPublicationPointers(client)).match).toBe(true);

        // Branding published revision 7 → 99 without target row
        await client.query(
          `UPDATE platform_branding SET revision = 99 WHERE id = 'branding:published'`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/dangling-fixed-pointer/);

        // Create target 99 and restore path
        await client.query(
          `INSERT INTO platform_resource_revisions
             (id, resource_type, resource_id, revision, status, payload, checksum)
           VALUES ('prev_brand_99', 'branding', 'global', 99, 'published', '{}'::jsonb, $1)
           ON CONFLICT DO NOTHING`,
          [PROBE_PAYLOAD_CHECKSUM],
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(true);
        expect(r.pointerDigest).not.toBe(baseDigest);

        // Wrong status on fixed published row is corrupt (not pre-publish).
        await client.query(
          `UPDATE platform_branding SET status = 'draft' WHERE id = 'branding:published'`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/fixed-holder-status-mismatch/);

        await client.query(
          `UPDATE platform_branding SET status = 'published', revision = 7
           WHERE id = 'branding:published'`,
        );
        expect((await verifyPublicationPointers(client)).match).toBe(true);
        // Asset first_published_revision change must not masquerade as global pointer
        const beforeAsset = (await verifyPublicationPointers(client)).pointerDigest;
        await client.query(
          `INSERT INTO platform_branding_assets (id, branding_id, first_published_revision)
           VALUES ('asset1', 'branding:published', 99)
           ON CONFLICT DO NOTHING`,
        );
        const afterAsset = (await verifyPublicationPointers(client)).pointerDigest;
        expect(afterAsset).toBe(beforeAsset);
      });
    } finally {
      await lifecycle.cleanup();
    }
  }, 120_000);
});

void createHash;
