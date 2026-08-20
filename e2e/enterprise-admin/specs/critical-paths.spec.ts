import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { expectSignedIn, signInContext } from '../support/auth';
import {
  assertStableAdminSurface,
  captureEvidence,
  captureThemeDeviceMatrix,
  ensureEvidenceDir,
  EVIDENCE_ROOT,
} from '../support/evidence';
import { startEnterpriseAdminRuntime, type SuiteRuntime } from '../support/infrastructure';
import {
  cleanupEnterpriseAdminSuite,
  createDurableRestoreHandle,
  digestFingerprint,
  registerSeedRestoreOnLifecycle,
  seedEnterpriseAdminSuite,
  snapshotGlobalDbDigest,
  type SuiteGlobalWriteManifest,
  type SuiteSeed,
} from '../support/seed';
import { ADMIN_COPY, VIEWPORTS } from '../support/selectors';
import {
  countUserSkillArtifacts,
  induceSkillCatalogOutage,
  type SkillOutageHandle,
} from '../support/skillOutage';
import {
  assertExactAccessNotGranted,
  assertExactManagedResourceDenied,
  assertExactPermissionDenied,
  assertSafeProjection,
  extractBatchData,
  trpcMutation,
  trpcQuery,
} from '../support/trpc';

let runtime: SuiteRuntime | undefined;
let seed: SuiteSeed | undefined;
let writeManifest: SuiteGlobalWriteManifest | undefined;

const reportLines: string[] = [];
const log = (line: string) => {
  reportLines.push(line);
  console.log(line);
};

const parseManagedRevision = (json: unknown): number => {
  const data = extractBatchData(json) as { baseRevision?: unknown };
  if (typeof data?.baseRevision !== 'number' || !Number.isFinite(data.baseRevision)) {
    throw new Error(
      `baseRevision missing/invalid in managedResources.get: ${JSON.stringify(data)}`,
    );
  }
  return data.baseRevision;
};

const parseManagedReadiness = (json: unknown): Record<string, boolean> => {
  const data = extractBatchData(json) as { readiness?: Record<string, boolean> };
  if (!data?.readiness || typeof data.readiness !== 'object') {
    throw new Error('readiness missing in managedResources.get');
  }
  return data.readiness;
};

test.beforeAll(async () => {
  await rm(EVIDENCE_ROOT, { force: true, recursive: true });
  await ensureEvidenceDir();
  runtime = await startEnterpriseAdminRuntime();
  // Single lifecycle owner: register durable restore BEFORE seed so COMMIT→handler has no gap.
  const durableRestore = createDurableRestoreHandle(runtime.databaseUrl);
  registerSeedRestoreOnLifecycle(runtime.lifecycle, durableRestore);
  const seeded = await seedEnterpriseAdminSuite(runtime.databaseUrl, durableRestore);
  seed = seeded.seed;
  writeManifest = seeded.manifest;
  log(
    `[enterprise-admin-e2e] namespace=${seed.namespace} app=${runtime.appUrl} mode=${runtime.mode} run=${runtime.runToken} dist=${runtime.nextDistDir ?? 'n/a'}`,
  );
});

test.afterAll(async () => {
  const failures: unknown[] = [];
  try {
    if (runtime && seed) {
      // Normal path: CAS restore then stop (hooks also cover signal path).
      await cleanupEnterpriseAdminSuite(runtime.databaseUrl, seed, writeManifest);
      // Clear hooks so stop does not double-restore.
      runtime.lifecycle.preCleanupHooks.length = 0;
      if (writeManifest && runtime.mode === 'external') {
        const after = await snapshotGlobalDbDigest(runtime.databaseUrl);
        expect(digestFingerprint(after)).toBe(digestFingerprint(writeManifest.before));
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await runtime?.stop();
  } catch (error) {
    failures.push(error);
  }
  const reportDir = await ensureEvidenceDir();
  await writeFile(
    path.join(reportDir, 'local-report.md'),
    [
      '# Enterprise Admin E2E — local report',
      '',
      `- app: ${runtime?.appUrl ?? 'n/a'}`,
      `- mode: ${runtime?.mode ?? 'n/a'}`,
      `- namespace: ${seed?.namespace ?? 'n/a'}`,
      '',
      '## Log',
      ...reportLines.map((l) => `- ${l}`),
      '',
      '## Teardown',
      failures.length === 0 ? '- clean' : `- failures: ${failures.length}`,
      '',
    ].join('\n'),
    'utf8',
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'enterprise-admin E2E teardown failed');
  }
});

const requireRuntime = () => {
  if (!runtime || !seed) throw new Error('suite runtime/seed missing — preflight blocked');
  return { runtime, seed };
};

test.describe.configure({ mode: 'default' });

test('ordinary user and workspace owner are denied /admin and admin APIs', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();

  for (const principal of [s.ordinary, s.owner] as const) {
    const context = await browser.newContext({
      baseURL: rt.appUrl,
      viewport: VIEWPORTS.desktop,
    });
    try {
      await signInContext(context, principal, rt.appUrl);
      await expectSignedIn(context.request);

      const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
      expect(access.ok, `${principal.roleLabel} getMyAccess http`).toBe(true);
      const accessData = extractBatchData(access.json) as { hasAdminAccess?: boolean };
      expect(accessData.hasAdminAccess).toBe(false);

      const system = await trpcQuery(context.request, 'admin.system.getStatus');
      expect(system.ok).toBe(false);
      // Ordinary/owner lack admin permissions → withPlatformPermission denial
      // (PLATFORM_PERMISSION_DENIED; legacy access-gate helper aliases to the same assert).
      assertExactAccessNotGranted(system);

      const page = await context.newPage();
      await page.goto('/admin');
      await captureEvidence(page, `denied-${principal.roleLabel}-admin`, {
        heading: ADMIN_COPY.accessDeniedTitle,
        requiredTexts: [ADMIN_COPY.accessDeniedTitle],
      });
      await page.close();
      log(`denied ${principal.roleLabel}`);
    } finally {
      await context.close();
    }
  }
});

test('super admin opens Admin Shell / System with safe projections', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const context = await browser.newContext({
    baseURL: rt.appUrl,
    viewport: VIEWPORTS.desktop,
  });
  try {
    await signInContext(context, s.superAdmin, rt.appUrl);
    await expectSignedIn(context.request);

    const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
    expect(access.ok).toBe(true);
    const accessData = extractBatchData(access.json) as {
      hasAdminAccess?: boolean;
      roles?: Array<{ name?: string }>;
    };
    expect(accessData.hasAdminAccess).toBe(true);
    expect(accessData.roles?.some((r) => r.name === 'super_admin')).toBe(true);

    const status = await trpcQuery(context.request, 'admin.system.getStatus');
    expect(status.ok, `getStatus failed: ${status.text.slice(0, 240)}`).toBe(true);
    const statusData = extractBatchData(status.json);
    assertSafeProjection(statusData);
    const flags = (statusData as { featureFlags?: { platformAdmin?: boolean } }).featureFlags;
    expect(flags?.platformAdmin).toBe(true);

    const page = await context.newPage();
    await page.goto('/admin');
    await expect(
      page
        .getByRole('link', { name: ADMIN_COPY.systemNav })
        .or(page.getByText(ADMIN_COPY.systemNav, { exact: true }))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByText(ADMIN_COPY.systemNav, { exact: true }).first().click();
    await page.waitForURL(/\/admin\/system/, { timeout: 30_000 });
    await captureEvidence(page, 'super-admin-system', {
      heading: ADMIN_COPY.systemTitle,
      requiredTexts: [ADMIN_COPY.systemTitle],
    });
    await expect(page.getByRole('heading', { name: 'Dependencies' })).toBeVisible();
    log('super admin shell + system ok');
  } finally {
    await context.close();
  }
});

test('auditor is read-only: dangerous job ops absent and operate API denied', async ({
  browser,
}) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const context = await browser.newContext({
    baseURL: rt.appUrl,
    viewport: VIEWPORTS.desktop,
  });
  try {
    await signInContext(context, s.auditor, rt.appUrl);
    await expectSignedIn(context.request);

    const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
    expect(access.ok).toBe(true);
    const accessData = extractBatchData(access.json) as {
      hasAdminAccess?: boolean;
      permissions?: string[];
      roles?: Array<{ name?: string }>;
    };
    expect(accessData.hasAdminAccess).toBe(true);
    expect(accessData.roles?.some((r) => r.name === 'auditor')).toBe(true);
    expect(accessData.permissions ?? []).not.toContain('platform_system:operate:all');

    const readStatus = await trpcQuery(context.request, 'admin.system.getStatus');
    expect(readStatus.ok, `auditor read status: ${readStatus.text.slice(0, 200)}`).toBe(true);
    assertSafeProjection(extractBatchData(readStatus.json));

    const retry = await trpcMutation(context.request, 'admin.system.retryJob', {
      expectedStatus: 'failed',
      jobId: 'pjob_0000000000000001',
      reason: 'auditor must not retry',
    });
    assertExactPermissionDenied(retry);

    const cancel = await trpcMutation(context.request, 'admin.system.cancelJob', {
      expectedStatus: 'running',
      jobId: 'pjob_0000000000000002',
      reason: 'auditor must not cancel',
    });
    assertExactPermissionDenied(cancel);

    const page = await context.newPage();
    await page.goto('/admin/system/status');
    await captureEvidence(page, 'auditor-system-readonly', {
      heading: ADMIN_COPY.systemTitle,
      requiredTexts: [ADMIN_COPY.systemJobsReadOnly, ADMIN_COPY.systemTitle],
    });
    await expect(page.getByRole('button', { name: /^Retry$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Cancel$/i })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Recent jobs' })).toBeVisible();
    log('auditor read-only ok');
  } finally {
    await context.close();
  }
});

test('skill catalog outage fails closed for legacy skill mutations', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();
  let outage: SkillOutageHandle | undefined;
  const context = await browser.newContext({ baseURL: rt.appUrl });
  const blockedIdentifier = `blocked-skill-${s.namespace}`;
  let bodyError: unknown;
  try {
    await signInContext(context, s.superAdmin, rt.appUrl);
    await expectSignedIn(context.request);

    const beforeArtifacts = await countUserSkillArtifacts(
      rt.databaseUrl,
      s.superAdmin.id,
      blockedIdentifier,
    );
    expect(beforeArtifacts.matchingIdentifiers).toEqual([]);

    outage = await induceSkillCatalogOutage({
      databaseUrl: rt.databaseUrl,
      redisUrl: rt.redisUrl,
    });

    let readiness: Record<string, boolean> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const readinessProbe = await trpcQuery(context.request, 'admin.managedResources.get');
      expect(readinessProbe.ok, readinessProbe.text.slice(0, 300)).toBe(true);
      readiness = parseManagedReadiness(readinessProbe.json);
      if (readiness.skills === false) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    expect(
      readiness?.skills,
      `expected skills readiness false, got ${JSON.stringify(readiness)}`,
    ).toBe(false);

    const create = await trpcMutation(context.request, 'agentSkills.create', {
      content: '# Skill\n\nBlocked by skill catalog outage fail-closed.',
      description: 'Must not install while skill catalog is out',
      identifier: blockedIdentifier,
      name: 'Blocked Skill Outage',
    });
    assertExactManagedResourceDenied(create);

    const afterArtifacts = await countUserSkillArtifacts(
      rt.databaseUrl,
      s.superAdmin.id,
      blockedIdentifier,
    );
    expect(afterArtifacts.agentSkillIds).toEqual(beforeArtifacts.agentSkillIds);
    expect(afterArtifacts.documentIds).toEqual(beforeArtifacts.documentIds);
    expect(afterArtifacts.matchingIdentifiers).toEqual([]);

    await outage.restore();
    outage = undefined;

    const restored = await trpcQuery(context.request, 'admin.managedResources.get');
    expect(restored.ok).toBe(true);
    const readinessAfter = parseManagedReadiness(restored.json);
    expect(readinessAfter.skills).toBe(true);

    log('skill catalog outage fail-closed + restore ok');
  } catch (error) {
    bodyError = error;
  }

  // Never swallow restore/context errors — teardown must fail the suite if fixtures remain.
  // Throws live outside `finally` (eslint no-unsafe-finally).
  const teardownErrors: unknown[] = [];
  if (outage) {
    try {
      await outage.restore();
    } catch (error) {
      teardownErrors.push(error);
    }
  }
  try {
    await context.close();
  } catch (error) {
    teardownErrors.push(error);
  }

  if (bodyError && teardownErrors.length > 0) {
    throw new AggregateError(
      [bodyError, ...teardownErrors],
      'skill-outage test body and teardown failed',
    );
  }
  if (bodyError) throw bodyError;
  if (teardownErrors.length === 1) throw teardownErrors[0];
  if (teardownErrors.length > 1) {
    throw new AggregateError(teardownErrors, 'skill-outage teardown failed');
  }
});

test('managed resources confirmation: reason required and cancel does not publish', async ({
  browser,
}) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const context = await browser.newContext({
    baseURL: rt.appUrl,
    viewport: VIEWPORTS.desktop,
  });
  try {
    await signInContext(context, s.superAdmin, rt.appUrl);
    await expectSignedIn(context.request);

    const before = await trpcQuery(context.request, 'admin.managedResources.get');
    expect(before.ok, `managedResources.get failed: ${before.text.slice(0, 200)}`).toBe(true);
    const beforeRevision = parseManagedRevision(before.json);

    const page = await context.newPage();
    await page.goto('/admin/managed-resources');
    await assertStableAdminSurface(page, {
      heading: 'Hosting policy',
      requiredTexts: ['Change reason'],
    });

    const switches = page.getByRole('switch');
    await expect(switches.first()).toBeVisible({ timeout: 30_000 });
    await switches.first().click();
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const saveButton = page.getByRole('button', { name: 'Save draft' });
    await expect(saveButton).toBeVisible({ timeout: 15_000 });
    await saveButton.click();
    await expect(
      page.getByText('Enter a reason (1–2000 characters).', { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    const reason = page.getByPlaceholder('Explain why this policy is changing…');
    await expect(reason).toBeVisible();
    await reason.fill('e2e confirmation cancel — do not publish');

    // Leave dialog: Stay
    await page.getByText(ADMIN_COPY.systemNav, { exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Unsaved managed resource changes', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(page.getByRole('heading', { name: 'Hosting policy' })).toBeVisible();
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible();

    // Leave dialog: Leave without saving
    await page.getByText(ADMIN_COPY.systemNav, { exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Leave without saving' }).click();
    await page.waitForURL(/\/admin\/system/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: ADMIN_COPY.systemTitle })).toBeVisible({
      timeout: 45_000,
    });

    const after = await trpcQuery(context.request, 'admin.managedResources.get');
    expect(after.ok).toBe(true);
    const afterRevision = parseManagedRevision(after.json);
    expect(afterRevision).toBe(beforeRevision);

    // Product contract: leave-without-saving retains recovery draft in localStorage.
    // Never mutate/remove the product key — re-enter and assert real recovery behavior.
    await page.goto('/admin/managed-resources');
    await assertStableAdminSurface(page, {
      heading: 'Hosting policy',
      requiredTexts: ['Change reason'],
    });
    // Recovery draft rehydrates dirty state (product intentional crash-recovery contract).
    await expect(page.getByText('Unsaved changes', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const recoveryKeyPresent = await page.evaluate(() =>
      Boolean(window.localStorage.getItem('aihub.admin.managedResources.draft')),
    );
    expect(recoveryKeyPresent).toBe(true);

    await captureEvidence(page, 'managed-resources-confirmation', {
      heading: 'Hosting policy',
      requiredTexts: ['Unsaved changes', 'Change reason'],
    });
    // Server revision still unchanged (no publish).
    const final = await trpcQuery(context.request, 'admin.managedResources.get');
    expect(parseManagedRevision(final.json)).toBe(beforeRevision);
    log('confirmation: reason-required + stay + leave + revision unchanged + recovery retained');
  } finally {
    await context.close();
  }
});

test('evidence matrix: light/dark × desktop/mobile with stable waits', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const bootstrap = await browser.newContext({ baseURL: rt.appUrl });
  try {
    await signInContext(bootstrap, s.superAdmin, rt.appUrl);
    const cookies = await bootstrap.cookies();
    const files = await captureThemeDeviceMatrix({
      baseURL: rt.appUrl,
      browser,
      cookies,
      prepare: async (page, _theme, device) => {
        await page.goto('/admin/system/status');
        await page.waitForLoadState('domcontentloaded');
        if (device === 'mobile') {
          await assertStableAdminSurface(page, {
            forbiddenTexts: [ADMIN_COPY.systemTitle, ADMIN_COPY.accessDeniedTitle],
            heading: ADMIN_COPY.mobileUnsupportedTitle,
          });
        } else {
          await assertStableAdminSurface(page, {
            forbiddenTexts: [ADMIN_COPY.mobileUnsupportedTitle, ADMIN_COPY.accessDeniedTitle],
            heading: ADMIN_COPY.systemTitle,
          });
        }
      },
      slug: 'admin-system',
    });
    expect(files.length).toBe(4);
    await mkdir(path.join(EVIDENCE_ROOT, 'manifests'), { recursive: true });
    await writeFile(
      path.join(EVIDENCE_ROOT, 'manifests', 'theme-device.json'),
      JSON.stringify({ count: files.length, files: files.map((f) => path.basename(f)) }, null, 2),
      'utf8',
    );
    log(`evidence matrix files=${files.length}`);
  } finally {
    await bootstrap.close();
  }
});
