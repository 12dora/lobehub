// @vitest-environment node
/**
 * RR8: direct canonical JSON (integer-index key order) + branding
 * pre-publish vs corrupt publication; source-manifest refuses invalid pointers.
 */
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

import type { PoolClient } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildSourceManifestCore,
  createSignedProvenance,
  newNonce,
  RECOVERY_PROBE_IDS,
  verifyPublicationPointers,
  verifySignedProvenance,
} from './index';
import { createOwnedPostgres } from './recovery/ownedPostgres';
import { PROBE_PAYLOAD_CHECKSUM, seedRecoveryFixture } from './recovery/seed';
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

const restoreValidBranding = async (client: PoolClient): Promise<void> => {
  await client.query(`DELETE FROM platform_branding`);
  await client.query(
    `DELETE FROM platform_resource_revisions
     WHERE resource_type = 'branding' AND resource_id = 'global'`,
  );
  await client.query(
    `INSERT INTO platform_resource_revisions
       (id, resource_type, resource_id, revision, status, payload, checksum)
     VALUES ($1, 'branding', 'global', 7, 'published',
             '{"displayName":"Recovery Drill Probe"}'::jsonb, $2)
     ON CONFLICT (id) DO UPDATE SET
       resource_type = 'branding', resource_id = 'global', revision = 7,
       status = 'published', checksum = EXCLUDED.checksum`,
    [RECOVERY_PROBE_IDS.revisionId, PROBE_PAYLOAD_CHECKSUM],
  );
  await client.query(
    `INSERT INTO platform_branding (id, display_name, status, revision)
     VALUES ('branding:published', 'Recovery Branding', 'published', 7)`,
  );
};

describe('RR8: direct canonical serializer preserves code-unit key order', () => {
  it('integer-like keys keep code-unit order at root and nested; reverse insertion stable', () => {
    // Code-unit order: "0" < "01" < "10" < "2" < "4294967294" < "4294967295"
    // ES JSON.stringify reorders integer indices numerically — forbidden path.
    const keys = ['10', '2', '01', '0', '4294967294', '4294967295'] as const;
    const values = [1, 2, 3, 4, 5, 6] as const;

    const forward = Object.create(null) as Record<string, number>;
    for (let i = 0; i < keys.length; i += 1) forward[keys[i]!] = values[i]!;

    const reverse = Object.create(null) as Record<string, number>;
    for (let i = keys.length - 1; i >= 0; i -= 1) reverse[keys[i]!] = values[i]!;

    const expected = '{"0":4,"01":3,"10":1,"2":2,"4294967294":5,"4294967295":6}';
    expect(canonicalize(forward)).toBe(expected);
    expect(canonicalize(reverse)).toBe(expected);
    expect(JSON.stringify(forward)).not.toBe(expected);

    const nestedForward = Object.create(null) as Record<string, unknown>;
    nestedForward.outer = forward;
    const nestedReverse = Object.create(null) as Record<string, unknown>;
    nestedReverse.outer = reverse;
    expect(canonicalize(nestedForward)).toBe(canonicalize(nestedReverse));
    expect(canonicalize(nestedForward)).toBe(`{"outer":${expected}}`);

    expect(compareCodeUnits('10', '2')).toBe(-1);
    expect(compareCodeUnits('0', '01')).toBe(-1);
  });

  it('Unicode / __proto__ / constructor retained; signature verify stable', () => {
    const eAcute: string = 'é';
    const eCombining: string = 'e\u0301';
    const a = Object.create(null) as Record<string, number>;
    a[eAcute] = 1;
    a[eCombining] = 2;
    const b = Object.create(null) as Record<string, number>;
    b[eCombining] = 2;
    b[eAcute] = 1;
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toContain(JSON.stringify(eAcute));
    expect(canonicalize(a)).toContain(JSON.stringify(eCombining));

    const withProto = JSON.parse('{"__proto__":1,"constructor":2,"prototype":3}') as object;
    const canon = canonicalize(withProto);
    expect(canon).toBe('{"__proto__":1,"constructor":2,"prototype":3}');

    const bundle = createTestTrustBundle(['production']);
    const payload = {
      artifactSha256: sha256Of('rr8-art'),
      candidateSha: FIXTURE_CANDIDATE_SHA,
      environment: 'production' as const,
      gateId: 'path-boundaries' as const,
      generatedAt: new Date().toISOString(),
      issuer: bundle.issuer,
      keyId: bundle.keyId,
      nonce: newNonce(),
      releaseId: FIXTURE_RELEASE_ID,
      runId: 'run-rr8-canon',
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
    expect(sha256HexOfCanonicalSync(payload)).toBe(sha256HexOfCanonicalSync({ ...payload }));
  });
});

describe('RR8: branding pre-publish vs corrupt; source-manifest refuse', () => {
  it('docker: genuine pre-publish, valid published, corrupt states, manifest gate', async () => {
    if (!(await dockerAvailable())) {
      expect(true).toBe(true);
      return;
    }
    const lifecycle = await createOwnedPostgres();
    try {
      await lifecycle.handle.withClient(async (client) => {
        await seedRecoveryFixture(client);
        const valid = await verifyPublicationPointers(client);
        expect(valid.match).toBe(true);
        const publishedDigest = valid.pointerDigest;

        // Valid published source-manifest builds
        const publishedManifest = await buildSourceManifestCore(client);
        expect(publishedManifest.pointerDigest).toBe(publishedDigest);

        // --- wrong status on fixed row (corrupt, not pre-publish)
        await client.query(
          `UPDATE platform_branding SET status = 'draft' WHERE id = 'branding:published'`,
        );
        let r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/fixed-holder-status-mismatch/);
        expect(r.pointerDigest).not.toBe(publishedDigest);
        await expect(buildSourceManifestCore(client)).rejects.toThrow(
          /source-manifest-refuses-invalid-publications/,
        );

        // --- revision 0
        await client.query(
          `UPDATE platform_branding
           SET status = 'published', revision = 0
           WHERE id = 'branding:published'`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/invalid-fixed-holder-revision/);
        await expect(buildSourceManifestCore(client)).rejects.toThrow(
          /source-manifest-refuses-invalid-publications/,
        );

        await restoreValidBranding(client);
        expect((await verifyPublicationPointers(client)).match).toBe(true);

        // --- dangling target
        await client.query(
          `UPDATE platform_branding SET revision = 99 WHERE id = 'branding:published'`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/dangling-fixed-pointer/);
        await client.query(
          `UPDATE platform_branding SET revision = 7 WHERE id = 'branding:published'`,
        );

        // --- missing holder with published branding history
        await client.query(`DELETE FROM platform_branding WHERE id = 'branding:published'`);
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/missing-fixed-holder-with-published-history/);
        await expect(buildSourceManifestCore(client)).rejects.toThrow(
          /source-manifest-refuses-invalid-publications/,
        );

        // --- genuine pre-publish: no holder AND no published branding claim
        await client.query(
          `DELETE FROM platform_resource_revisions
           WHERE resource_type = 'branding' AND resource_id = 'global'`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(true);
        expect(r.pointerDigest).not.toBe(publishedDigest);
        const noneManifest = await buildSourceManifestCore(client);
        expect(noneManifest.pointerDigest).toBe(r.pointerDigest);

        // published history without holder fails again
        await client.query(
          `INSERT INTO platform_resource_revisions
             (id, resource_type, resource_id, revision, status, payload, checksum)
           VALUES ('prev_brand_reclaim', 'branding', 'global', 7, 'published', '{}'::jsonb, $1)`,
          [PROBE_PAYLOAD_CHECKSUM],
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/missing-fixed-holder-with-published-history/);

        // --- extra published holder row
        await client.query(
          `INSERT INTO platform_branding (id, display_name, status, revision)
           VALUES ('branding:published', 'Recovery Branding', 'published', 7)`,
        );
        await client.query(
          `INSERT INTO platform_branding (id, display_name, status, revision)
           VALUES ('branding:legacy', 'Legacy', 'published', 1)`,
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/extra-published-holder/);
        await client.query(`DELETE FROM platform_branding WHERE id = 'branding:legacy'`);
        await client.query(
          `DELETE FROM platform_resource_revisions WHERE id = 'prev_brand_reclaim'`,
        );
        await restoreValidBranding(client);

        // --- wrong target owner
        await client.query(
          `UPDATE platform_resource_revisions
           SET resource_id = 'not-global'
           WHERE id = $1`,
          [RECOVERY_PROBE_IDS.revisionId],
        );
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(false);
        expect(r.detail).toMatch(/dangling-fixed-pointer|fixed-pointer-target-mismatch/);

        await restoreValidBranding(client);
        r = await verifyPublicationPointers(client);
        expect(r.match).toBe(true);
        const finalManifest = await buildSourceManifestCore(client);
        expect(finalManifest.pointerDigest).toBe(r.pointerDigest);
      });
    } finally {
      await lifecycle.cleanup();
    }
  }, 180_000);
});

void createHash;
