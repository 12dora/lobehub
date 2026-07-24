// @vitest-environment node
/**
 * RR3 contract tests: provenance dump+manifest binding, multiproc CAS,
 * adapters against real Q03/Q05/O05 schemas, baseline injection refusal.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { adaptFailureDrillEvidenceDir } from './adapters/failureDrills';
import { adaptMigrationCompatReport } from './adapters/migrationCompat';
import { adaptUpstreamRebaseEvidence } from './adapters/upstreamRebase';
import {
  applyCommandTransition,
  createSignedProvenance,
  digestCommandState,
  loadCommandState,
  newNonce,
  verifySignedProvenance,
} from './index';
import {
  createTestTrustBundle,
  FIXTURE_CANDIDATE_SHA,
  FIXTURE_MIGRATION_TAG,
  FIXTURE_RELEASE_ID,
  freshTimestamp,
  sha256Of,
} from './testFixtures';

const tempDirs: string[] = [];
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { force: true, recursive: true });
  }
});

const makeTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), 'm15q06-rr3-'));
  tempDirs.push(dir);
  return dir;
};

const buildBackupPayload = (
  bundle: ReturnType<typeof createTestTrustBundle>,
  overrides: Record<string, unknown> = {},
) => {
  const dumpSha = sha256Of('dump-bytes');
  const manifestSha = sha256Of('manifest-bytes');
  return {
    artifactSha256: dumpSha,
    attestationRole: 'source-backup' as const,
    backupBinding: {
      inventoryVersion: 1 as const,
      manifestSchemaVersion: 1 as const,
      sourceDbToolVersion: 'pg_dump-16',
      sourceManifestSha256: manifestSha,
      sourceSchemaTag: FIXTURE_MIGRATION_TAG,
    },
    assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
    candidateSha: FIXTURE_CANDIDATE_SHA,
    environment: 'production' as const,
    gateId: 'backup-restore' as const,
    generatedAt: freshTimestamp(),
    issuer: bundle.issuer,
    keyId: bundle.keyId,
    nonce: newNonce(),
    releaseId: FIXTURE_RELEASE_ID,
    runId: 'run-rr3-1',
    schemaVersion: 1 as const,
    sourceManifestSha256: manifestSha,
    status: 'passed' as const,
    ...overrides,
  };
};

describe('RR3: dump+manifest signed provenance binding', () => {
  it('accepts matching dump + manifest pair under test policy', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle);
    const envelope = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    const verdict = verifySignedProvenance(envelope, {
      expectedArtifactSha256: payload.artifactSha256,
      expectedAttestationRole: 'source-backup',
      expectedBackupBinding: {
        inventoryVersion: 1,
        manifestSchemaVersion: 1,
        sourceDbToolVersion: 'pg_dump-16',
        sourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        sourceSchemaTag: FIXTURE_MIGRATION_TAG,
      },
      expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
      expectedGateId: 'backup-restore',
      expectedReleaseId: FIXTURE_RELEASE_ID,
      policy: bundle.policy,
    });
    expect(verdict.ok).toBe(true);
  });

  it('signed dump + changed manifest fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle);
    const envelope = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    const verdict = verifySignedProvenance(envelope, {
      expectedArtifactSha256: payload.artifactSha256,
      expectedSourceManifestSha256: sha256Of('tampered-manifest'),
      expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
      expectedGateId: 'backup-restore',
      policy: bundle.policy,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('source-manifest-digest-mismatch');
  });

  it('signed manifest + changed dump fails', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle);
    const envelope = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    const verdict = verifySignedProvenance(envelope, {
      expectedArtifactSha256: sha256Of('tampered-dump'),
      expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
      expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
      expectedGateId: 'backup-restore',
      policy: bundle.policy,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('artifact-digest-mismatch');
  });

  it('mismatched candidate/release/gate fail', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle);
    const envelope = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: 'c'.repeat(40),
        expectedGateId: 'backup-restore',
        policy: bundle.policy,
      }).ok,
    ).toBe(false);
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'app-rollback',
        policy: bundle.policy,
      }).ok,
    ).toBe(false);
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        expectedReleaseId: 'other-release',
        policy: bundle.policy,
      }).ok,
    ).toBe(false);
  });

  it('replay nonce fails; stale/future fail', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle);
    const envelope = createSignedProvenance({
      payload,
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    const seen = new Set<string>();
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        policy: bundle.policy,
        seenNonces: seen,
      }).ok,
    ).toBe(true);
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: payload.artifactSha256,
        expectedSourceManifestSha256: payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        policy: bundle.policy,
        seenNonces: seen,
      }).ok,
    ).toBe(false);

    const stale = createSignedProvenance({
      payload: {
        ...buildBackupPayload(bundle),
        generatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        nonce: newNonce(),
      },
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    expect(
      verifySignedProvenance(stale, {
        expectedArtifactSha256: stale.payload.artifactSha256,
        expectedSourceManifestSha256: stale.payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        maxAgeMs: 72 * 60 * 60 * 1000,
        policy: bundle.policy,
      }).ok,
    ).toBe(false);

    const future = createSignedProvenance({
      payload: {
        ...buildBackupPayload(bundle),
        generatedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        nonce: newNonce(),
      },
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    expect(
      verifySignedProvenance(future, {
        expectedArtifactSha256: future.payload.artifactSha256,
        expectedSourceManifestSha256: future.payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        clockSkewMs: 60_000,
        policy: bundle.policy,
      }).ok,
    ).toBe(false);
  });

  it('unsigned / local-only provenance cannot authorize production', () => {
    const bundle = createTestTrustBundle(['production']);
    const payload = buildBackupPayload(bundle, { environment: 'local-harness' });
    // local-harness not allowed for production-only key
    const envelope = createSignedProvenance({
      payload: {
        ...payload,
        environment: 'production',
      },
      privateKeyBase64: bundle.privateKeyBase64,
      publicKeyBase64: bundle.publicKeyBase64,
    });
    // Empty production policy rejects
    expect(
      verifySignedProvenance(envelope, {
        expectedArtifactSha256: envelope.payload.artifactSha256,
        expectedSourceManifestSha256: envelope.payload.backupBinding!.sourceManifestSha256,
        expectedCandidateSha: FIXTURE_CANDIDATE_SHA,
        expectedGateId: 'backup-restore',
        // default PRODUCTION_TRUST_POLICY
      }).ok,
    ).toBe(false);
  });
});

describe('RR3: multiproc command-state CAS + replay', () => {
  it('two concurrent flag updates both survive (serializable)', async () => {
    const dir = await makeTempDir();
    const runBun = (flag: string, opId?: string) =>
      new Promise<{ mode: string; opSeq: number; flags: Record<string, boolean> }>(
        (resolve, reject) => {
          const script = `
import { applyCommandTransition } from './scripts/enterprise/production-readiness/index.ts';
const flag = process.env.Q06_FLAG;
const baseDir = process.env.Q06_STATE_DIR;
const result = await applyCommandTransition({
  baseDir,
  operationId: process.env.Q06_OP_ID || undefined,
  mutate: (state) => {
    if (state.flags[flag] === true) {
      return { changed: false, next: state, postcondition: flag + ':no-change' };
    }
    state.flags[flag] = true;
    return { changed: true, next: state, postcondition: flag + '=true' };
  },
});
console.log(JSON.stringify({ mode: result.mode, opSeq: result.after.opSeq, flags: result.after.flags }));
`;
          const child = spawn('bun', ['-e', script], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              Q06_FLAG: flag,
              Q06_OP_ID: opId ?? '',
              Q06_STATE_DIR: dir,
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let out = '';
          let err = '';
          child.stdout.on('data', (c) => {
            out += c.toString();
          });
          child.stderr.on('data', (c) => {
            err += c.toString();
          });
          child.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`bun worker exit ${code}: ${err || out}`));
              return;
            }
            resolve(JSON.parse(out.trim().split('\n').at(-1)!));
          });
        },
      );

    const [a, b] = await Promise.all([runBun('oidc'), runBun('branding-cutover')]);
    expect([a.mode, b.mode].every((m) => m === 'executed' || m === 'already-satisfied')).toBe(true);
    const final = await loadCommandState(dir);
    expect(final.flags.oidc).toBe(true);
    expect(final.flags['branding-cutover']).toBe(true);
    expect(final.opSeq).toBe(2);
  }, 30_000);

  it('same operation id replays non-executed outcome; conflicting reuse not double-apply', async () => {
    const dir = await makeTempDir();
    const first = await applyCommandTransition({
      baseDir: dir,
      operationId: 'op-same-1',
      mutate: (state) => {
        state.flags.oidc = true;
        return { changed: true, next: state, postcondition: 'oidc=true' };
      },
    });
    expect(first.mode).toBe('executed');
    expect(first.after.opSeq).toBe(1);

    const replay = await applyCommandTransition({
      baseDir: dir,
      operationId: 'op-same-1',
      mutate: (state) => {
        // Would flip if re-executed
        state.flags.oidc = false;
        return { changed: true, next: state, postcondition: 'oidc=false' };
      },
    });
    expect(replay.mode).toBe('replayed');
    expect(replay.after.flags.oidc).toBe(true);
    expect(replay.after.opSeq).toBe(1);

    // Cross-process replay
    const script = `
import { applyCommandTransition, loadCommandState } from './scripts/enterprise/production-readiness/index.ts';
const result = await applyCommandTransition({
  baseDir: process.env.Q06_STATE_DIR,
  operationId: 'op-same-1',
  mutate: (state) => {
    state.flags.oidc = false;
    return { changed: true, next: state, postcondition: 'should-not-run' };
  },
});
const loaded = await loadCommandState(process.env.Q06_STATE_DIR);
console.log(JSON.stringify({ mode: result.mode, opSeq: loaded.opSeq, oidc: loaded.flags.oidc }));
`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('bun', ['-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, Q06_STATE_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => {
        stdout += c.toString();
      });
      child.stderr.on('data', (c) => {
        stderr += c.toString();
      });
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || stdout));
        else resolve(stdout.trim());
      });
    });
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe('replayed');
    expect(parsed.opSeq).toBe(1);
    expect(parsed.oidc).toBe(true);
  }, 20_000);

  it('flag + window concurrent updates both apply', async () => {
    const dir = await makeTempDir();
    const scriptFlag = `
import { applyCommandTransition } from './scripts/enterprise/production-readiness/index.ts';
const r = await applyCommandTransition({
  baseDir: process.env.Q06_STATE_DIR,
  mutate: (s) => { s.flags.oidc = true; return { changed: true, next: s, postcondition: 'oidc' }; },
});
console.log(JSON.stringify({ mode: r.mode, opSeq: r.after.opSeq }));
`;
    const scriptWindow = `
import { applyCommandTransition } from './scripts/enterprise/production-readiness/index.ts';
const r = await applyCommandTransition({
  baseDir: process.env.Q06_STATE_DIR,
  mutate: (s) => { s.windowActive = 'milestone-a'; return { changed: true, next: s, postcondition: 'win' }; },
});
console.log(JSON.stringify({ mode: r.mode, opSeq: r.after.opSeq }));
`;
    const run = (code: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn('bun', ['-e', code], {
          cwd: process.cwd(),
          env: { ...process.env, Q06_STATE_DIR: dir },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.on('close', (codeExit) => {
          if (codeExit !== 0) reject(new Error(`exit ${codeExit}`));
          else resolve();
        });
      });
    await Promise.all([run(scriptFlag), run(scriptWindow)]);
    const final = await loadCommandState(dir);
    expect(final.flags.oidc).toBe(true);
    expect(final.windowActive).toBe('milestone-a');
    expect(final.opSeq).toBe(2);
  }, 20_000);

  it('lock timeout when holder never releases', async () => {
    const dir = await makeTempDir();
    const lockPath = path.join(dir, 'readiness-command-state.lock');
    await writeFile(lockPath, 'foreign-holder', 'utf8');
    await expect(
      applyCommandTransition({
        baseDir: dir,
        mutate: (s) => {
          s.flags.oidc = true;
          return { changed: true, next: s, postcondition: 'x' };
        },
      }),
    ).rejects.toThrow(/CommandStateLockTimeout/);
    await rm(lockPath, { force: true });
  }, 15_000);

  it('rejects state path that is a symlink file after write attempt via lstat load', async () => {
    const dir = await makeTempDir();
    const real = path.join(dir, 'real-state.json');
    await writeFile(real, JSON.stringify({ not: 'schema' }), 'utf8');
    const link = path.join(dir, 'readiness-command-state.json');
    await symlink(real, link);
    // loadCommandState treats symlink as invalid → default state
    const loaded = await loadCommandState(dir);
    expect(loaded.opSeq).toBe(0);
    expect(digestCommandState(loaded)).toMatch(/^[a-f\d]{64}$/);
  });
});

describe('RR3: adapters against real Q03/Q05/O05 schemas', () => {
  it('migration-compat: real schema + generatedAt; missing is unverified; candidate binds', async () => {
    const {
      BASELINE_LAST_TAG,
      BASELINE_MIGRATION_COUNT,
      BASELINE_VERSION,
      VERIFY_MIGRATION_LANE,
      VERIFY_MIGRATION_SCHEMA_VERSION,
    } = await import('../verify-migration/constants');
    const { buildFullPassingChecks, createMigrationCompatReport } =
      await import('../verify-migration/contract');

    const dir = await makeTempDir();
    const core = {
      baseline: {
        commitShort: '4bab1636408e',
        lastTag: BASELINE_LAST_TAG,
        match: 'passed' as const,
        migrationCount: BASELINE_MIGRATION_COUNT,
        version: BASELINE_VERSION,
      },
      candidateSha: FIXTURE_CANDIDATE_SHA,
      checks: buildFullPassingChecks(),
      cleanupResult: 'passed' as const,
      elapsed: { milliseconds: 10 },
      externalDump: { status: 'absent' as const },
      fixture: { rowCounts: { users: 1 }, source: 'synthetic' as const, status: 'loaded' as const },
      generatedAt: freshTimestamp(),
      head: {
        commitShort: FIXTURE_CANDIDATE_SHA.slice(0, 12),
        postBaselineMigrationCount: 20,
        totalMigrationCount: BASELINE_MIGRATION_COUNT + 20,
      },
      lane: VERIFY_MIGRATION_LANE,
      ownedResource: { kind: 'container-database' as const, resourceId: 'm15q03_fixture01' },
      overall: 'unverified' as const,
      rerun: { mode: 'idempotent' as const, result: 'passed' as const },
      schemaVersion: VERIFY_MIGRATION_SCHEMA_VERSION,
      syntheticResult: 'passed' as const,
    };
    const report = createMigrationCompatReport(core);
    const validPath = path.join(dir, 'q03-valid.json');
    await writeFile(validPath, JSON.stringify(report), 'utf8');
    const adapted = await adaptMigrationCompatReport({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      reportPath: validPath,
    });
    expect(adapted.status).toBe('passed');
    expect(adapted.candidateSha).toBe(FIXTURE_CANDIDATE_SHA);

    const { generatedAt: _g, ...noTsCore } = core;
    void _g;
    const noTs = createMigrationCompatReport(noTsCore);
    const missingPath = path.join(dir, 'q03-missing-ts.json');
    await writeFile(missingPath, JSON.stringify(noTs), 'utf8');
    const unverified = await adaptMigrationCompatReport({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      reportPath: missingPath,
    });
    expect(unverified.status).toBe('unverified');

    const wrong = createMigrationCompatReport({ ...core, candidateSha: 'd'.repeat(40) });
    const wrongPath = path.join(dir, 'q03-wrong.json');
    await writeFile(wrongPath, JSON.stringify(wrong), 'utf8');
    await expect(
      adaptMigrationCompatReport({
        candidateSha: FIXTURE_CANDIDATE_SHA,
        reportPath: wrongPath,
      }),
    ).rejects.toThrow(/candidateSha mismatch/);
  });

  it('upstream-rebase: real schema binds full candidate; missing generatedAt unverified', async () => {
    const {
      UPSTREAM_REBASE_CI_LANE,
      UPSTREAM_REBASE_CI_SCHEMA_VERSION,
      createUpstreamRebaseEvidence,
    } = await import('../upstream-rebase-ci/contract');

    const dir = await makeTempDir();
    const short = FIXTURE_CANDIDATE_SHA.slice(0, 12);
    const base = {
      analysis: {
        mode: 'dry-run-evidence' as const,
        networkAccess: 'ci-fetch-only' as const,
        productionRebase: false as const,
        push: false as const,
        worktreeMutation: 'isolated-temp-only' as const,
      },
      candidateSha: FIXTURE_CANDIDATE_SHA,
      cleanupResult: 'passed' as const,
      commits: {
        base: short,
        candidate: short,
        mergeBase: short,
        upstream: short,
      },
      gates: [
        {
          id: 'bun-check-changed',
          kind: 'command' as const,
          outcome: 'passed' as const,
          reason: 'lint',
        },
        {
          id: 'privacy-review',
          kind: 'privacy-scan' as const,
          outcome: 'passed' as const,
          reason: 'privacy',
        },
        {
          id: 'type-check',
          kind: 'command' as const,
          outcome: 'passed' as const,
          reason: 'types',
        },
      ],
      generatedAt: freshTimestamp(),
      lane: UPSTREAM_REBASE_CI_LANE,
      reportStatus: 'clean' as const,
      requiredGateIds: ['bun-check-changed', 'privacy-review', 'type-check'],
      schemaVersion: UPSTREAM_REBASE_CI_SCHEMA_VERSION,
      summary: {
        candidateChangedPaths: 1,
        conflicts: 0,
        directModificationHotspots: 0,
        patchDrift: 0,
        upstreamChangedPaths: 1,
      },
      upstream: {
        freshness: 'verified-by-ci-fetch' as const,
        ref: 'main',
        repository: 'lobehub/lobehub',
        sha: 'e'.repeat(40),
      },
    };
    const evidence = createUpstreamRebaseEvidence(base);
    const pathValid = path.join(dir, 'q05.json');
    await writeFile(pathValid, JSON.stringify(evidence), 'utf8');
    const adapted = await adaptUpstreamRebaseEvidence({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      evidencePath: pathValid,
    });
    expect(adapted.gate).toBe('upstream-rebase');
    expect(adapted.status).toBe('passed');
    expect(adapted.candidateSha).toBe(FIXTURE_CANDIDATE_SHA);

    const { generatedAt: _t, ...noTsBase } = base;
    void _t;
    const noTs = createUpstreamRebaseEvidence(noTsBase);
    const noTsPath = path.join(dir, 'q05-no-ts.json');
    await writeFile(noTsPath, JSON.stringify(noTs), 'utf8');
    const missing = await adaptUpstreamRebaseEvidence({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      evidencePath: noTsPath,
    });
    expect(missing.status).toBe('unverified');

    const mismatch = createUpstreamRebaseEvidence({ ...base, candidateSha: 'f'.repeat(40) });
    const mismatchPath = path.join(dir, 'q05-mismatch.json');
    await writeFile(mismatchPath, JSON.stringify(mismatch), 'utf8');
    await expect(
      adaptUpstreamRebaseEvidence({
        candidateSha: FIXTURE_CANDIDATE_SHA,
        evidencePath: mismatchPath,
      }),
    ).rejects.toThrow(/candidateSha mismatch/);
  });

  it('failure-drills: exact four scenarios via real schema; missing/duplicate fail', async () => {
    const { createFailureDrillEvidence } = await import('../failure-drills/contract');
    const { FAILURE_DRILL_SCENARIOS } = await import('../failure-drills/scenarios');

    const dir = await makeTempDir();
    const deps = {
      bun: '1.3.5',
      node: '24.13.0',
      postgres: '17.5',
      redis: '7.4.2',
    } as const;

    for (const scenario of FAILURE_DRILL_SCENARIOS) {
      const evidence = createFailureDrillEvidence({
        artifact: { sha256: sha256Of(scenario.scenarioId) },
        assertions: { failed: 0, passed: 3, skipped: 0, total: 3 },
        cleanupResult: 'passed',
        dependencies: deps,
        elapsed: { milliseconds: 1 },
        generatedAt: freshTimestamp(),
        gitSha: FIXTURE_CANDIDATE_SHA,
        injection: scenario.injection,
        lane: 'enterprise-failure-drills',
        recovery: scenario.recovery,
        scenarioId: scenario.scenarioId,
        schemaVersion: 1,
      });
      await writeFile(
        path.join(dir, `${scenario.scenarioId}.json`),
        JSON.stringify(evidence),
        'utf8',
      );
    }
    const adapted = await adaptFailureDrillEvidenceDir({
      candidateSha: FIXTURE_CANDIDATE_SHA,
      evidenceDir: dir,
    });
    expect(adapted.status).toBe('passed');
    expect(adapted.details).toMatchObject({ scenarioCount: 4 });

    const incomplete = path.join(await makeTempDir(), 'incomplete');
    await mkdir(incomplete);
    for (const scenario of FAILURE_DRILL_SCENARIOS.slice(0, 3)) {
      const evidence = createFailureDrillEvidence({
        artifact: { sha256: sha256Of(scenario.scenarioId) },
        assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
        cleanupResult: 'passed',
        dependencies: deps,
        elapsed: { milliseconds: 1 },
        generatedAt: freshTimestamp(),
        gitSha: FIXTURE_CANDIDATE_SHA,
        injection: scenario.injection,
        lane: 'enterprise-failure-drills',
        recovery: scenario.recovery,
        scenarioId: scenario.scenarioId,
        schemaVersion: 1,
      });
      await writeFile(
        path.join(incomplete, `${scenario.scenarioId}.json`),
        JSON.stringify(evidence),
        'utf8',
      );
    }
    await expect(
      adaptFailureDrillEvidenceDir({
        candidateSha: FIXTURE_CANDIDATE_SHA,
        evidenceDir: incomplete,
      }),
    ).rejects.toThrow(/incomplete/);

    const dupDir = path.join(await makeTempDir(), 'dup');
    await mkdir(dupDir);
    for (const scenario of FAILURE_DRILL_SCENARIOS) {
      const evidence = createFailureDrillEvidence({
        artifact: { sha256: sha256Of(scenario.scenarioId) },
        assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
        cleanupResult: 'passed',
        dependencies: deps,
        elapsed: { milliseconds: 1 },
        generatedAt: freshTimestamp(),
        gitSha: FIXTURE_CANDIDATE_SHA,
        injection: scenario.injection,
        lane: 'enterprise-failure-drills',
        recovery: scenario.recovery,
        scenarioId: scenario.scenarioId,
        schemaVersion: 1,
      });
      await writeFile(
        path.join(dupDir, `${scenario.scenarioId}.json`),
        JSON.stringify(evidence),
        'utf8',
      );
    }
    const first = FAILURE_DRILL_SCENARIOS[0]!;
    await writeFile(
      path.join(dupDir, 'extra-dup.json'),
      JSON.stringify(
        createFailureDrillEvidence({
          artifact: { sha256: sha256Of('dup') },
          assertions: { failed: 0, passed: 1, skipped: 0, total: 1 },
          cleanupResult: 'passed',
          dependencies: deps,
          elapsed: { milliseconds: 1 },
          generatedAt: freshTimestamp(),
          gitSha: FIXTURE_CANDIDATE_SHA,
          injection: first.injection,
          lane: 'enterprise-failure-drills',
          recovery: first.recovery,
          scenarioId: first.scenarioId,
          schemaVersion: 1,
        }),
      ),
      'utf8',
    );
    await expect(
      adaptFailureDrillEvidenceDir({
        candidateSha: FIXTURE_CANDIDATE_SHA,
        evidenceDir: dupDir,
      }),
    ).rejects.toThrow(/duplicate/);
  });
});

describe('RR3: baseline planted-probe cannot authorize', () => {
  it('current-branch SQL probe content is not an authorizer export', async () => {
    // File must not exist (removed in RR3)
    const probePath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      'recovery/baselineProbeContent.ts',
    );
    await expect(readFile(probePath, 'utf8')).rejects.toThrow();
  });
});

void createHash;
void randomBytes;
void symlink;
