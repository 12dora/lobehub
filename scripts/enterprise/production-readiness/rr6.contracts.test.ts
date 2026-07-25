// @vitest-environment node
/**
 * RR6: exact generatedAt binding, recursive audit canonicalization, holder checksum FK.
 */
import { rm } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { assertDockerAvailableForIntegration, probeDockerAvailable } from './dockerAvailability';
import {
  createSignedProvenance,
  digestAuditLogs,
  digestCanonicalValue,
  evaluateProductionReadiness,
  newNonce,
  RECOVERY_PROBE_IDS,
  verifyPublicationPointers,
  verifySignedProvenance,
} from './index';
import { createOwnedPostgres } from './recovery/ownedPostgres';
import { PROBE_PAYLOAD_CHECKSUM_V2, seedRecoveryFixture } from './recovery/seed';
import {
  buildCandidate,
  buildFullSignedProductionEvidence,
  buildPlan,
  createTestTrustBundle,
  FIXTURE_CANDIDATE_SHA,
  FIXTURE_MIGRATION_TAG,
  FIXTURE_RELEASE_ID,
  freshTimestamp,
  sha256Of,
} from './testFixtures';
import { canonicalize } from './trust/canonical';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true }).catch(() => undefined);
  }
});

const hasDocker = await probeDockerAvailable();
assertDockerAvailableForIntegration(hasDocker);

describe('RR6: exact generatedAt binding for production provenance', () => {
  it('exact generatedAt passes; earlier-but-fresh signed payload fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const evidence = buildFullSignedProductionEvidence(bundle);
    const { exitCode, report } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence,
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: bundle.policy,
    });
    expect(exitCode).toBe(0);
    expect(report.overall).toBe('passed');

    // Re-sign one gate with earlier-but-still-fresh generatedAt
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const tampered = evidence.map((item) => {
      if (item.gate !== 'path-boundaries') return item;
      const provenance = createSignedProvenance({
        payload: {
          artifactSha256: item.artifactSha256,
          assertions: item.assertions,
          candidateSha: item.candidateSha,
          environment: 'production',
          gateId: item.gate,
          generatedAt: earlier,
          issuer: bundle.issuer,
          keyId: bundle.keyId,
          nonce: newNonce(),
          releaseId: FIXTURE_RELEASE_ID,
          runId: 'run-earlier',
          schemaVersion: 1,
          status: item.status,
        },
        privateKeyBase64: bundle.privateKeyBase64,
        publicKeyBase64: bundle.publicKeyBase64,
      });
      return { ...item, provenance };
    });
    const { report: r2 } = evaluateProductionReadiness({
      candidate: buildCandidate(),
      evidence: tampered,
      mode: 'production-authorized',
      plan: buildPlan(),
      trustPolicy: bundle.policy,
    });
    expect(r2.checks.find((c) => c.gate === 'path-boundaries')?.result).toBe('failed');
    expect(r2.overall).not.toBe('passed');
  });

  it('verifySignedProvenance rejects ±1ms and different ISO for different instant', () => {
    const bundle = createTestTrustBundle(['production']);
    const t0 = freshTimestamp();
    const payload = {
      artifactSha256: sha256Of('art'),
      assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
      candidateSha: FIXTURE_CANDIDATE_SHA,
      environment: 'production' as const,
      gateId: 'path-boundaries' as const,
      generatedAt: t0,
      issuer: bundle.issuer,
      keyId: bundle.keyId,
      nonce: newNonce(),
      releaseId: FIXTURE_RELEASE_ID,
      runId: 'run-ts',
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
        expectedGeneratedAt: t0,
        policy: bundle.policy,
      }).ok,
    ).toBe(true);

    // +1 ms ISO string (different instant if parseable as different ms)
    const laterMs = new Date(Date.parse(t0) + 1).toISOString();
    expect(
      verifySignedProvenance(env, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'path-boundaries',
        expectedGeneratedAt: laterMs,
        policy: bundle.policy,
      }).ok,
    ).toBe(false);

    // Earlier-but-fresh expected value
    const earlier = new Date(Date.parse(t0) - 60_000).toISOString();
    const fail = verifySignedProvenance(env, {
      expectedArtifactSha256: payload.artifactSha256,
      expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
      expectedGateId: 'path-boundaries',
      expectedGeneratedAt: earlier,
      policy: bundle.policy,
    });
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.reason).toBe('generated-at-mismatch');
  });
});

describe('RR6: recursive audit/after_diff canonicalization', () => {
  it('nested object value changes produce different digests', () => {
    const a = digestCanonicalValue({ outer: { x: 1 } });
    const b = digestCanonicalValue({ outer: { x: 2 } });
    expect(a).not.toBe(b);
    // key order equivalent
    expect(canonicalize({ b: 1, a: { z: 2, y: 1 } })).toBe(
      canonicalize({ a: { y: 1, z: 2 }, b: 1 }),
    );
    // array order preserved
    expect(digestCanonicalValue([1, 2])).not.toBe(digestCanonicalValue([2, 1]));
  });

  it.skipIf(!hasDocker)(
    'docker: nested after_diff pairs differ in audit digest',
    async () => {
      const lifecycle = await createOwnedPostgres();
      try {
        await lifecycle.handle.withClient(async (client) => {
          await seedRecoveryFixture(client);
          await client.query(`DELETE FROM platform_audit_logs`);
          await client.query(
            `INSERT INTO platform_audit_logs (id, action, result, after_diff)
           VALUES ('n1', 'act', 'ok', '{"outer":{"x":1}}'::jsonb)`,
          );
          const d1 = await digestAuditLogs(client);
          await client.query(`DELETE FROM platform_audit_logs`);
          await client.query(
            `INSERT INTO platform_audit_logs (id, action, result, after_diff)
           VALUES ('n1', 'act', 'ok', '{"outer":{"x":2}}'::jsonb)`,
          );
          const d2 = await digestAuditLogs(client);
          expect(d1.digest).not.toBe(d2.digest);

          // deeper nesting
          await client.query(`DELETE FROM platform_audit_logs`);
          await client.query(
            `INSERT INTO platform_audit_logs (id, action, result, after_diff)
           VALUES ('n1', 'act', 'ok', '{"a":{"b":{"c":[1,2]}}}'::jsonb)`,
          );
          const deep1 = await digestAuditLogs(client);
          await client.query(`DELETE FROM platform_audit_logs`);
          await client.query(
            `INSERT INTO platform_audit_logs (id, action, result, after_diff)
           VALUES ('n1', 'act', 'ok', '{"a":{"b":{"c":[2,1]}}}'::jsonb)`,
          );
          const deep2 = await digestAuditLogs(client);
          expect(deep1.digest).not.toBe(deep2.digest);
        });
      } finally {
        await lifecycle.cleanup();
      }
    },
    120_000,
  );
});

describe('RR6: holder-side checksum and composite FK for connectors', () => {
  it.skipIf(!hasDocker)(
    'docker: changed published_checksum fails; binding owner still works',
    async () => {
      const lifecycle = await createOwnedPostgres();
      try {
        await lifecycle.handle.withClient(async (client) => {
          await seedRecoveryFixture(client);
          const ok = await verifyPublicationPointers(client);
          expect(ok.match).toBe(true);
          const before = ok.pointerDigest;

          // Mutate holder published_checksum to another valid 64-hex without matching target
          await client.query(
            `UPDATE platform_connectors SET published_checksum = $1 WHERE id = $2`,
            [sha256Of('wrong-holder-checksum'), RECOVERY_PROBE_IDS.connectorId],
          );
          const bad = await verifyPublicationPointers(client);
          expect(bad.match).toBe(false);
          expect(bad.detail).toMatch(/dangling-pointer|holder-checksum/);

          // Restore correct checksum
          await client.query(
            `UPDATE platform_connectors SET published_checksum = $1 WHERE id = $2`,
            [PROBE_PAYLOAD_CHECKSUM_V2, RECOVERY_PROBE_IDS.connectorId],
          );
          const restored = await verifyPublicationPointers(client);
          expect(restored.match).toBe(true);
          expect(restored.pointerDigest).toBe(before);

          // Wrong published_resource_type
          await client.query(
            `UPDATE platform_connectors SET published_resource_type = 'branding' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.connectorId],
          );
          const wrongType = await verifyPublicationPointers(client);
          expect(wrongType.match).toBe(false);

          await client.query(
            `UPDATE platform_connectors SET published_resource_type = 'connector' WHERE id = $1`,
            [RECOVERY_PROBE_IDS.connectorId],
          );

          // binding wrong connector_id still fails
          await client.query(
            `UPDATE platform_user_connector_bindings SET connector_id = 'nope'
           WHERE id = 'pcub_m15q06_probe_01'`,
          );
          const badBind = await verifyPublicationPointers(client);
          expect(badBind.match).toBe(false);

          await client.query(
            `UPDATE platform_user_connector_bindings SET connector_id = $1
           WHERE id = 'pcub_m15q06_probe_01'`,
            [RECOVERY_PROBE_IDS.connectorId],
          );

          // agent checksum mutation still changes digest
          const beforeAgent = await verifyPublicationPointers(client);
          await client.query(`UPDATE platform_agent_versions SET checksum = $1 WHERE id = $2`, [
            sha256Of('agent-ck-mut'),
            RECOVERY_PROBE_IDS.agentVersionId,
          ]);
          const afterAgent = await verifyPublicationPointers(client);
          expect(afterAgent.pointerDigest).not.toBe(beforeAgent.pointerDigest);
        });
      } finally {
        await lifecycle.cleanup();
      }
    },
    120_000,
  );
});

void FIXTURE_MIGRATION_TAG;
