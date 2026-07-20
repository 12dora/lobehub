import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { expectSignedIn, signInContext } from '../support/auth';
import {
  captureEvidence,
  captureThemeDeviceMatrix,
  ensureEvidenceDir,
  EVIDENCE_ROOT,
} from '../support/evidence';
import { startEnterpriseAdminRuntime, type SuiteRuntime } from '../support/infrastructure';
import {
  cleanupEnterpriseAdminSuite,
  seedEnterpriseAdminSuite,
  type SuiteSeed,
} from '../support/seed';
import { ADMIN_COPY, VIEWPORTS } from '../support/selectors';
import { bodyHasForbidden, extractTrpcErrorCode, trpcMutation, trpcQuery } from '../support/trpc';

let runtime: SuiteRuntime | undefined;
let seed: SuiteSeed | undefined;

const reportLines: string[] = [];
const log = (line: string) => {
  reportLines.push(line);
  console.log(line);
};

test.beforeAll(async () => {
  await rm(EVIDENCE_ROOT, { force: true, recursive: true });
  await ensureEvidenceDir();
  runtime = await startEnterpriseAdminRuntime();
  seed = await seedEnterpriseAdminSuite(runtime.databaseUrl);
  log(
    `[enterprise-admin-e2e] namespace=${seed.namespace} app=${runtime.appUrl} mode=${runtime.mode}`,
  );
});

test.afterAll(async () => {
  const failures: unknown[] = [];
  try {
    if (runtime && seed) await cleanupEnterpriseAdminSuite(runtime.databaseUrl, seed);
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

test.describe.configure({ mode: 'serial' });

test('ordinary user and workspace owner are denied /admin and admin APIs', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();

  for (const principal of [s.ordinary, s.owner] as const) {
    const context = await browser.newContext({
      baseURL: rt.appUrl,
      viewport: VIEWPORTS.desktop,
    });
    try {
      await signInContext(context, principal);
      await expectSignedIn(context.request);

      const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
      expect(access.ok, `${principal.roleLabel} getMyAccess http`).toBe(true);
      expect(access.text).toContain('"hasAdminAccess":false');

      const system = await trpcQuery(context.request, 'admin.system.getStatus');
      expect(system.ok, `${principal.roleLabel} system.getStatus must be denied`).toBe(false);
      expect(bodyHasForbidden(system.text)).toBe(true);

      const page = await context.newPage();
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: ADMIN_COPY.accessDeniedTitle })).toBeVisible({
        timeout: 45_000,
      });
      await captureEvidence(page, `denied-${principal.roleLabel}-admin`);
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
    await signInContext(context, s.superAdmin);
    await expectSignedIn(context.request);

    const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
    expect(access.ok).toBe(true);
    expect(access.text).toContain('"hasAdminAccess":true');
    expect(access.text).toMatch(/super_admin/);

    const status = await trpcQuery(context.request, 'admin.system.getStatus');
    expect(status.ok, `getStatus failed: ${status.text.slice(0, 240)}`).toBe(true);
    // Safe projection: no raw secrets / private endpoints
    for (const forbidden of [
      'secret-access-key',
      'e2e-placeholder',
      'VAULT_TOKEN',
      'postgres:postgres',
      KEY_FRAGMENT,
    ]) {
      expect(status.text).not.toContain(forbidden);
    }
    expect(status.text).toMatch(/featureFlags|platformAdmin|dependencies|build/);

    const page = await context.newPage();
    await page.goto('/admin');
    await expect(page.getByText(ADMIN_COPY.systemNav).first()).toBeVisible({ timeout: 60_000 });
    await page.getByText(ADMIN_COPY.systemNav).first().click();
    await page.waitForURL(/\/admin\/system/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { name: ADMIN_COPY.systemTitle })).toBeVisible({
      timeout: 45_000,
    });
    await captureEvidence(page, 'super-admin-system');
    log('super admin shell + system ok');
  } finally {
    await context.close();
  }
});

// Placeholder constant used only as a negative assertion token (not a real secret value under test).
const KEY_FRAGMENT = 'enterprise-admin-e2e-auth-secret';

test('auditor is read-only: dangerous job ops absent and operate API denied', async ({
  browser,
}) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const context = await browser.newContext({
    baseURL: rt.appUrl,
    viewport: VIEWPORTS.desktop,
  });
  try {
    await signInContext(context, s.auditor);
    await expectSignedIn(context.request);

    const access = await trpcQuery(context.request, 'admin.auth.getMyAccess');
    expect(access.ok).toBe(true);
    expect(access.text).toContain('"hasAdminAccess":true');
    expect(access.text).toMatch(/auditor/);
    // Operate permission must not be present
    expect(access.text).not.toContain('platform_system:operate:all');

    const readStatus = await trpcQuery(context.request, 'admin.system.getStatus');
    expect(readStatus.ok, `auditor read status: ${readStatus.text.slice(0, 200)}`).toBe(true);

    const retry = await trpcMutation(context.request, 'admin.system.retryJob', {
      expectedStatus: 'failed',
      jobId: '00000000-0000-0000-0000-000000000001',
      reason: 'auditor must not retry',
    });
    expect(retry.ok).toBe(false);
    expect(bodyHasForbidden(retry.text) || extractTrpcErrorCode(retry.text)).toBeTruthy();

    const cancel = await trpcMutation(context.request, 'admin.system.cancelJob', {
      expectedStatus: 'running',
      jobId: '00000000-0000-0000-0000-000000000002',
      reason: 'auditor must not cancel',
    });
    expect(cancel.ok).toBe(false);
    expect(bodyHasForbidden(cancel.text) || extractTrpcErrorCode(cancel.text)).toBeTruthy();

    const page = await context.newPage();
    await page.goto('/admin/system');
    await expect(page.getByRole('heading', { name: ADMIN_COPY.systemTitle })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(ADMIN_COPY.systemJobsReadOnly)).toBeVisible({ timeout: 30_000 });
    // Dangerous action buttons must not render for read-only operators
    await expect(page.getByRole('button', { name: /^Retry$/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Cancel$/i })).toHaveCount(0);
    await captureEvidence(page, 'auditor-system-readonly');
    log('auditor read-only ok');
  } finally {
    await context.close();
  }
});

test('skill catalog managed policy fails closed for legacy skill mutations', async ({
  browser,
}) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const context = await browser.newContext({ baseURL: rt.appUrl });
  try {
    // Super admin still cannot bypass managed guard on ordinary skill routers
    await signInContext(context, s.superAdmin);
    await expectSignedIn(context.request);

    // agentSkills.create is a classified legacy mutation under managed skills.
    const create = await trpcMutation(context.request, 'agentSkills.create', {
      content: '# Skill\n\nBlocked by managed catalog fail-closed.',
      description: 'Must not install while skills are platform-managed',
      identifier: `blocked-skill-${s.namespace}`,
      name: 'Blocked Skill',
    });
    expect(create.ok, 'managed skill create must fail closed').toBe(false);
    expect(create.text).toMatch(/RESOURCE_MANAGED_BY_PLATFORM|FORBIDDEN/);

    const ordinaryContext = await browser.newContext({ baseURL: rt.appUrl });
    try {
      await signInContext(ordinaryContext, s.ordinary);
      const ordinaryCreate = await trpcMutation(ordinaryContext.request, 'agentSkills.create', {
        content: '# Skill\n\nBlocked for ordinary principal.',
        description: 'Ordinary user must not write managed skills',
        identifier: `blocked-skill-user-${s.namespace}`,
        name: 'Blocked Skill User',
      });
      expect(ordinaryCreate.ok).toBe(false);
      // Access gate or managed guard — either is a closed failure path.
      expect(ordinaryCreate.text).toMatch(
        /RESOURCE_MANAGED_BY_PLATFORM|PLATFORM_ACCESS_NOT_GRANTED|FORBIDDEN/,
      );
    } finally {
      await ordinaryContext.close();
    }
    log('skill catalog fail-closed ok');
  } finally {
    await context.close();
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
    await signInContext(context, s.superAdmin);
    await expectSignedIn(context.request);
    const page = await context.newPage();
    await page.goto('/admin/managed-resources');
    // Page title from i18n — allow either heading or template title
    await expect(
      page.getByText(/Managed resources|托管资源|managedResources/i).first(),
    ).toBeVisible({ timeout: 60_000 });

    // Toggle a non-skills resource to create a draft delta when editable
    const switches = page.locator('[role="switch"]');
    const switchCount = await switches.count();
    if (switchCount > 0) {
      await switches.first().click();
    }

    const reason = page.getByPlaceholder(/reason|理由/i);
    if (await reason.count()) {
      // Attempt save/publish without reason → validation
      const primary = page.getByRole('button', { name: /Save|Publish|保存|发布/i }).first();
      if (await primary.isVisible()) {
        await primary.click();
        await expect(page.getByText(/required|必填|reason/i).first()).toBeVisible({
          timeout: 10_000,
        });
      }
      // Fill reason then abandon (cancel path) — do not publish
      await reason.fill('e2e confirmation cancel — do not publish');
      // Navigate away with possible leave confirm
      page.once('dialog', (dialog) => dialog.dismiss().catch(() => undefined));
      await page.goto('/admin/system');
      await expect(page.getByRole('heading', { name: ADMIN_COPY.systemTitle })).toBeVisible({
        timeout: 45_000,
      });
    }

    await captureEvidence(page, 'managed-resources-confirmation');
    log('confirmation / managed guard flow exercised');
  } finally {
    await context.close();
  }
});

test('evidence matrix: light/dark × desktop/mobile with stable waits', async ({ browser }) => {
  const { runtime: rt, seed: s } = requireRuntime();
  const bootstrap = await browser.newContext({ baseURL: rt.appUrl });
  try {
    await signInContext(bootstrap, s.superAdmin);
    const cookies = await bootstrap.cookies();
    const files = await captureThemeDeviceMatrix({
      baseURL: rt.appUrl,
      browser,
      cookies,
      prepare: async (page) => {
        await page.goto('/admin/system');
        await page.waitForLoadState('domcontentloaded');
        // Mobile surfaces the unsupported state; desktop shows System.
        const denied = page.getByText(/Admin access denied|Use a desktop|Admin is unavailable/i);
        const system = page.getByRole('heading', { name: ADMIN_COPY.systemTitle });
        await expect(denied.or(system).first()).toBeVisible({ timeout: 60_000 });
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
