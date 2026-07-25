// @vitest-environment node
/**
 * RR9: published target status for publication pointers; branding history
 * is status-independent; source-manifest refuses corrupt targets/history.
 */
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { assertDockerAvailableForIntegration, probeDockerAvailable } from './dockerAvailability';
import { buildSourceManifestCore, RECOVERY_PROBE_IDS, verifyPublicationPointers } from './index';
import { createOwnedPostgres } from './recovery/ownedPostgres';
import { PROBE_PAYLOAD_CHECKSUM, seedRecoveryFixture } from './recovery/seed';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
  }
});

const hasDocker = await probeDockerAvailable();
assertDockerAvailableForIntegration(hasDocker);

describe('RR9: published target status + status-independent branding history', () => {
  it.skipIf(!hasDocker)(
    'docker: archived/draft target fails; missing holder with any history fails; manifest refuses',
    async () => {
      const lifecycle = await createOwnedPostgres();
      try {
        await lifecycle.handle.withClient(async (client) => {
          await seedRecoveryFixture(client);
          const valid = await verifyPublicationPointers(client);
          expect(valid.match).toBe(true);
          await expect(buildSourceManifestCore(client)).resolves.toBeTruthy();

          // --- archived target of fixed branding pointer
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'archived' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.revisionId],
          );
          let r = await verifyPublicationPointers(client);
          expect(r.match).toBe(false);
          expect(r.detail).toMatch(/fixed-target-revision-status-mismatch/);
          await expect(buildSourceManifestCore(client)).rejects.toThrow(
            /source-manifest-refuses-invalid-publications/,
          );

          // --- draft target
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'draft' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.revisionId],
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(false);
          expect(r.detail).toMatch(/fixed-target-revision-status-mismatch/);
          await expect(buildSourceManifestCore(client)).rejects.toThrow(
            /source-manifest-refuses-invalid-publications/,
          );

          // restore published target
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'published' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.revisionId],
          );
          expect((await verifyPublicationPointers(client)).match).toBe(true);

          // --- connector published pointer to archived target fails (domain rule)
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'archived'
           WHERE resource_type = 'connector' AND resource_id = $1 AND revision = 2`,
            [RECOVERY_PROBE_IDS.connectorId],
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(false);
          expect(r.detail).toMatch(/target-revision-status-mismatch/);
          await expect(buildSourceManifestCore(client)).rejects.toThrow(
            /source-manifest-refuses-invalid-publications/,
          );
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'published'
           WHERE resource_type = 'connector' AND resource_id = $1 AND revision = 2`,
            [RECOVERY_PROBE_IDS.connectorId],
          );
          expect((await verifyPublicationPointers(client)).match).toBe(true);

          // --- missing holder + archived history is NOT pre-publish
          await client.query(`DELETE FROM platform_branding WHERE id = 'branding:published'`);
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'archived' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.revisionId],
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(false);
          expect(r.detail).toMatch(/missing-fixed-holder-with-revision-history/);
          await expect(buildSourceManifestCore(client)).rejects.toThrow(
            /source-manifest-refuses-invalid-publications/,
          );

          // --- missing holder + draft history still fails
          await client.query(
            `UPDATE platform_resource_revisions SET status = 'draft' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.revisionId],
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(false);
          expect(r.detail).toMatch(/missing-fixed-holder-with-revision-history/);
          await expect(buildSourceManifestCore(client)).rejects.toThrow(
            /source-manifest-refuses-invalid-publications/,
          );

          // --- genuine pre-publish: no holder, zero branding/global history
          await client.query(
            `DELETE FROM platform_resource_revisions
           WHERE resource_type = 'branding' AND resource_id = 'global'`,
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(true);
          const noneManifest = await buildSourceManifestCore(client);
          expect(noneManifest.pointerDigest).toBe(r.pointerDigest);

          // re-seed published holder+target
          await client.query(
            `INSERT INTO platform_resource_revisions
             (id, resource_type, resource_id, revision, status, payload, checksum)
           VALUES ($1, 'branding', 'global', 7, 'published',
                   '{"displayName":"Recovery Drill Probe"}'::jsonb, $2)
           ON CONFLICT (id) DO UPDATE SET status = 'published', resource_id = 'global',
             resource_type = 'branding', revision = 7, checksum = EXCLUDED.checksum`,
            [RECOVERY_PROBE_IDS.revisionId, PROBE_PAYLOAD_CHECKSUM],
          );
          await client.query(
            `INSERT INTO platform_branding (id, display_name, status, revision)
           VALUES ('branding:published', 'Recovery Branding', 'published', 7)
           ON CONFLICT (id) DO UPDATE SET status = 'published', revision = 7`,
          );
          r = await verifyPublicationPointers(client);
          expect(r.match).toBe(true);
          await expect(buildSourceManifestCore(client)).resolves.toBeTruthy();
        });
      } finally {
        await lifecycle.cleanup();
      }
    },
    180_000,
  );
});
