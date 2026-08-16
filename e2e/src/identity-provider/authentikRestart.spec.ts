import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { Pool } from 'pg';

import { type AuthentikFixture, startAuthentikFixture } from './authentikFixture';
import { type FixtureProxy, startFixtureProxy } from './fixtureProxy';
import { RestartingWebServer } from './restartingWebServer';
import {
  cleanupPublishedIdentityProvider,
  E2E_ADMIN,
  IDENTITY_PROVIDER_ID,
  IDENTITY_PROVIDER_KEY,
  seedPublishedIdentityProvider,
} from './seedIdentityProvider';

const { join, resolve } = path;

const execute = promisify(execFile);
const PROJECT_ROOT = resolve(__dirname, '../../..');
const EVIDENCE_DIR =
  process.env.E2E_IDP_EVIDENCE_DIR ?? resolve(PROJECT_ROOT, '.records/identity-provider-e2e');
const CLIENT_SECRET = 'identity-provider-e2e-client-secret';
const AUTH_SECRET = 'identity-provider-e2e-auth-secret-at-least-32-characters';
const KEY_VAULTS_SECRET = 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';
const MASTER_KEY = randomBytes(32).toString('base64');

interface ContainerHandle {
  name: string;
}

let postgres: ContainerHandle | undefined;
let redis: ContainerHandle | undefined;
let fixture: AuthentikFixture | undefined;
let proxy: FixtureProxy | undefined;
let supervisor: RestartingWebServer | undefined;
let databaseUrl = '';
let appUrl = '';
let tempDirectory = '';

const freePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('port unavailable'));
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });

const runCommand = async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
  new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolveCommand();
      reject(new Error(`${command} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  });

const startContainer = async (input: {
  args: string[];
  image: string;
  name: string;
}): Promise<ContainerHandle> => {
  await execute('docker', ['run', '--detach', '--name', input.name, ...input.args, input.image]);
  return { name: input.name };
};

const stopContainer = async (container: ContainerHandle | undefined) => {
  if (!container) return;
  await execute('docker', ['rm', '--force', container.name]).catch(() => undefined);
};

const waitForPostgres = async (url: string) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1000 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
  }
  throw new Error('isolated PostgreSQL failed to start');
};

const signInWithPassword = async (page: Page) => {
  if (!new URL(page.url()).searchParams.has('callbackUrl')) {
    throw new Error('reauth popup is missing its callback path');
  }
  const emailInput = page.locator('input[inputmode="email"]');
  await expect(emailInput).toHaveCount(1);
  await expect(emailInput).toBeVisible();
  await emailInput.fill(E2E_ADMIN.email);
  const password = page.locator('input[type="password"]');
  if (!(await password.isVisible())) {
    await page.locator('button[type="submit"]').click();
    await expect(password).toBeVisible();
  }
  await password.fill(E2E_ADMIN.password);
  const completion = Promise.any([
    page.waitForEvent('close', { timeout: 30_000 }).then(() => 'closed' as const),
    page
      .waitForURL((url) => url.pathname === '/admin/reauth-complete', { timeout: 30_000 })
      .then(() => 'complete' as const),
  ]);
  await page.locator('button[type="submit"]').click();
  try {
    const outcome = await completion;
    if (outcome === 'complete') {
      await Promise.any([
        page.waitForEvent('close', { timeout: 10_000 }),
        page.getByRole('status').waitFor({ state: 'visible', timeout: 10_000 }),
      ]);
    }
  } catch (error) {
    const pathname = page.isClosed() ? 'closed' : new URL(page.url()).pathname;
    const visibleErrorCount = page.isClosed()
      ? 0
      : await page.locator('.ant-form-item-explain-error, [role="alert"]').count();
    throw new Error(
      `reauth popup did not complete after password sign-in (path=${pathname}, visibleErrors=${visibleErrorCount})`,
      { cause: error },
    );
  }
};

const screenshot = async (page: Page, fileName: string) => {
  await page.screenshot({ path: join(EVIDENCE_DIR, fileName) });
};

const recordRestartFrames = async (page: Page, action: () => Promise<void>) => {
  const frameDirectory = join(EVIDENCE_DIR, 'restart-frames');
  await mkdir(frameDirectory, { recursive: true });
  let stopped = false;
  let index = 0;
  const capture = (async () => {
    while (!stopped && index < 24) {
      await page
        .screenshot({ path: join(frameDirectory, `frame-${String(index).padStart(3, '0')}.png`) })
        .catch(() => undefined);
      index += 1;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  })();
  try {
    await action();
  } finally {
    stopped = true;
    await capture;
  }
  await page.screenshot({
    path: join(frameDirectory, `frame-${String(index).padStart(3, '0')}.png`),
  });
  await execute('ffmpeg', [
    '-y',
    '-framerate',
    '4',
    '-i',
    join(frameDirectory, 'frame-%03d.png'),
    '-vf',
    'fps=4,scale=1200:-2:flags=lanczos,tpad=stop_mode=clone:stop_duration=2',
    join(EVIDENCE_DIR, 'restart-timeline.gif'),
  ]);
};

test.beforeAll(async () => {
  await rm(EVIDENCE_DIR, { force: true, recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
  tempDirectory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-idp-e2e-')));
  await chmod(tempDirectory, 0o700);
  await mkdir(join(tempDirectory, 'lkg'), { mode: 0o700, recursive: true });
  const suffix = `${process.pid}-${Date.now()}`;
  const databaseName = `aihub_idp_${suffix.replaceAll('-', '_')}`;
  const postgresPort = await freePort();
  const redisPort = await freePort();
  const appPort = await freePort();
  postgres = await startContainer({
    args: [
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      `POSTGRES_DB=${databaseName}`,
      '-p',
      `127.0.0.1:${postgresPort}:5432`,
    ],
    image: 'paradedb/paradedb:latest-pg17',
    name: `aihub-idp-pg-${suffix}`,
  });
  redis = await startContainer({
    args: ['-p', `127.0.0.1:${redisPort}:6379`],
    image: 'redis:7-alpine',
    name: `aihub-idp-redis-${suffix}`,
  });
  databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${databaseName}`;
  appUrl = `http://localhost:${appPort}`;
  await waitForPostgres(databaseUrl);

  fixture = await startAuthentikFixture({
    clientSecret: CLIENT_SECRET,
    expectedRedirectUri: `${appUrl}/api/auth/oauth2/callback/${IDENTITY_PROVIDER_KEY}`,
    requireNonce: true,
  });
  proxy = await startFixtureProxy(fixture.port);
  const env = {
    ...process.env,
    APP_URL: appUrl,
    AUTH_TRUSTED_ORIGINS: appUrl,
    AUTH_EMAIL_VERIFICATION: '0',
    AUTH_SECRET,
    DATABASE_DRIVER: 'node',
    DATABASE_URL: databaseUrl,
    ENABLE_DATABASE_OIDC: '1',
    ENABLE_PLATFORM_ADMIN: '1',
    KEY_VAULTS_SECRET,
    PLATFORM_MASTER_KEY: MASTER_KEY,
    PLATFORM_MASTER_KEY_ID: 'identity-provider-e2e-key',
    PLATFORM_OIDC_LKG_PATH: join(tempDirectory, 'lkg', 'snapshot.json'),
    PLATFORM_OIDC_RESTART_MODE: 'supervisor',
    PORT: String(appPort),
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
    S3_ACCESS_KEY_ID: 'e2e-placeholder',
    S3_BUCKET: 'e2e-placeholder',
    S3_ENDPOINT: 'https://s3.invalid',
    S3_SECRET_ACCESS_KEY: 'e2e-placeholder',
  } satisfies NodeJS.ProcessEnv;
  await runCommand('bun', ['run', 'db:migrate'], { ...env, NODE_ENV: 'agenttest' });
  const migrationProof = new Pool({ connectionString: databaseUrl });
  const migrated = await migrationProof.query(
    `SELECT current_database() AS database_name,
       to_regclass('public.platform_identity_providers') IS NOT NULL AS identity_table,
       to_regclass('public.users') IS NOT NULL AS users_table`,
  );
  await migrationProof.end();
  expect(migrated.rows[0]).toEqual({
    database_name: databaseName,
    identity_table: true,
    users_table: true,
  });
  expect(new URL(databaseUrl).port).toBe(String(postgresPort));

  await runCommand('bun', ['run', 'build'], { ...env, NODE_ENV: 'production' });
  const buildIdPath = resolve(PROJECT_ROOT, '.next/BUILD_ID');
  expect((await stat(buildIdPath)).isFile()).toBe(true);
  expect((await readFile(buildIdPath, 'utf8')).trim()).not.toBe('');
  const buildSideEffectProof = new Pool({ connectionString: databaseUrl });
  const buildInstances = await buildSideEffectProof.query(
    'SELECT count(*)::int AS count FROM platform_identity_provider_instances',
  );
  await buildSideEffectProof.end();
  expect(buildInstances.rows[0]).toEqual({ count: 0 });

  const dispatcherPath = resolve(
    PROJECT_ROOT,
    'e2e/src/identity-provider/installFixtureDispatcher.mjs',
  );
  supervisor = new RestartingWebServer({
    cwd: PROJECT_ROOT,
    env: {
      ...env,
      E2E_IDP_FIXTURE_PORT: String(fixture.port),
      E2E_IDP_PROXY_URL: proxy.url,
      NODE_EXTRA_CA_CERTS: fixture.caCertificatePath,
      NODE_OPTIONS: `--import=${dispatcherPath} --max-old-space-size=6144`,
    },
    healthUrl: `${appUrl}/signin`,
    port: appPort,
    startupTimeoutMs: 150_000,
  });
  // The first real process must load before the provider exists.
  await supervisor.start();
  const startupProof = new Pool({ connectionString: databaseUrl });
  const startupInstances = await startupProof.query(
    `SELECT instance_id, health, degraded_category, startup_source,
       last_heartbeat >= clock_timestamp() - interval '45 seconds' AS fresh
       FROM platform_identity_provider_instances`,
  );
  await startupProof.end();
  expect(startupInstances.rows).toHaveLength(1);
  expect(startupInstances.rows[0]).toMatchObject({
    degraded_category: null,
    fresh: true,
    health: 'healthy',
    startup_source: 'database',
  });

  const first = await seedPublishedIdentityProvider({
    clientSecret: CLIENT_SECRET,
    databaseUrl,
    masterKey: MASTER_KEY,
  });
  const second = await seedPublishedIdentityProvider({
    clientSecret: CLIENT_SECRET,
    databaseUrl,
    masterKey: MASTER_KEY,
  });
  expect(second.payload).toEqual(first.payload);
  const pool = new Pool({ connectionString: databaseUrl });
  const idempotency = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM platform_identity_providers WHERE id = $1) AS providers,
       (SELECT count(*)::int FROM platform_identity_provider_secrets WHERE provider_id = $1) AS secrets,
       (SELECT count(*)::int FROM platform_resource_revisions WHERE resource_type = 'oidc' AND resource_id = $1) AS revisions`,
    [IDENTITY_PROVIDER_ID],
  );
  await pool.end();
  expect(idempotency.rows[0]).toEqual({ providers: 1, revisions: 1, secrets: 1 });
});

test.afterAll(async () => {
  const cleanupSteps: Array<() => Promise<unknown>> = [
    () => supervisor?.stop() ?? Promise.resolve(),
    () => proxy?.close() ?? Promise.resolve(),
    () => fixture?.close() ?? Promise.resolve(),
    () =>
      databaseUrl ? cleanupPublishedIdentityProvider(databaseUrl) : Promise.resolve(undefined),
    () => stopContainer(redis),
    () => stopContainer(postgres),
    () =>
      tempDirectory
        ? rm(tempDirectory, { force: true, recursive: true })
        : Promise.resolve(undefined),
  ];
  const results = [];
  for (const step of cleanupSteps) results.push(await Promise.allSettled([step()]));
  const failures = results.flat().filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    console.error('[identity-provider-e2e] teardown failures', { count: failures.length });
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'identity-provider E2E teardown failed',
    );
  }
});

test('activates a published Authentik provider across a real supervised restart', async ({
  browser,
}) => {
  test.slow();
  let context: BrowserContext | undefined;
  let oidcContext: BrowserContext | undefined;
  let breakGlassContext: BrowserContext | undefined;
  let cleanupError: AggregateError | undefined;
  let flowError: unknown;
  let pool: Pool | undefined;
  try {
    context = await browser.newContext({ baseURL: appUrl });
    const loginResponse = await context.request.post('/api/auth/sign-in/email', {
      data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
    });
    expect(loginResponse.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto('/admin/identity-providers');
    await expect(page.getByText('Authentik Work Account')).toBeVisible();
    const runtime = page.getByTestId('identity-runtime-status');
    await expect(runtime).toBeVisible();
    await expect(runtime).toContainText('1 published provider revision(s) await activation.');
    await screenshot(page, '01-pending-restart.png');
    const oldPid = supervisor!.pid;

    pool = new Pool({ connectionString: databaseUrl });
    const oldInstanceResult = await pool.query(
      `SELECT instance_id, active_identity_revision
         FROM platform_identity_provider_instances
        WHERE last_heartbeat >= clock_timestamp() - interval '45 seconds'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    expect(oldInstanceResult.rows).toHaveLength(1);
    const oldInstance = oldInstanceResult.rows[0] as {
      active_identity_revision: string | null;
      instance_id: string;
    };

    await page.getByRole('button', { name: /Restart to activate|重启/ }).click();
    const confirmation = page.getByRole('dialog');
    await expect(confirmation).toBeVisible();
    const popupPromise = page.waitForEvent('popup');
    await confirmation.getByRole('button', { name: /Restart safely|安全重启|确认/ }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    await expect(popup.locator('input[inputmode="email"]')).toBeVisible();
    await screenshot(popup, '02-reauth-popup.png');
    await signInWithPassword(popup);

    const reasonDialog = page.getByRole('dialog').filter({ has: page.locator('textarea') });
    await expect(reasonDialog).toBeVisible({ timeout: 30_000 });
    if (!popup.isClosed()) await popup.close();
    await reasonDialog.locator('textarea').fill('Activate reviewed E2E identity revision');
    await recordRestartFrames(page, async () => {
      await reasonDialog.getByRole('button', { name: /Restart safely|安全重启|确认/ }).click();
      const reconnectingAlert = page.getByRole('alert').filter({
        hasText:
          /^(Restart accepted\. The server is reconnecting; status checks will resume automatically\.|重启请求已接受，服务器正在重连；状态检查会自动恢复。)$/,
      });
      await expect(reconnectingAlert).toHaveCount(1);
      await expect(reconnectingAlert).toBeVisible();
      await supervisor!.waitForGeneration(2);
      const activatedAlert = page.getByRole('alert').filter({
        hasText:
          /^(Activation complete\. Every fresh instance is running the target published revision\.|激活完成，所有在线实例均已运行目标发布版本。)$/,
      });
      await expect(activatedAlert).toHaveCount(1, { timeout: 120_000 });
      await expect(activatedAlert).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByTestId('identity-runtime-status')).toContainText(
        '0 published provider revision(s) await activation.',
      );
    });
    expect(supervisor!.pid).not.toBe(oldPid);

    // Preserve accepted-attempt state while polling reconnects across the real process death.
    await screenshot(page, '05-active-after-natural-stale.png');

    const status = await pool.query(
      `SELECT status, activation_revision FROM platform_identity_providers WHERE id = $1`,
      [IDENTITY_PROVIDER_ID],
    );
    const oldInstanceAfter = await pool.query(
      `SELECT instance_id, active_identity_revision,
         last_heartbeat < clock_timestamp() - interval '90 seconds' AS stale
         FROM platform_identity_provider_instances
        WHERE instance_id = $1`,
      [oldInstance.instance_id],
    );
    const successor = await pool.query(
      `SELECT instance_id, startup_source, active_identity_revision,
         last_heartbeat < clock_timestamp() - interval '90 seconds' AS stale
         FROM platform_identity_provider_instances
        WHERE instance_id <> $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [oldInstance.instance_id],
    );
    expect(status.rows[0]).toMatchObject({ activation_revision: 1, status: 'active' });
    expect(oldInstanceAfter.rows[0]).toMatchObject({
      active_identity_revision: oldInstance.active_identity_revision,
      instance_id: oldInstance.instance_id,
      stale: true,
    });
    expect(successor.rows[0]).toMatchObject({ stale: false, startup_source: 'database' });
    expect(successor.rows[0].active_identity_revision).toMatch(/^[a-f0-9]{64}$/);
    expect(successor.rows[0].active_identity_revision).not.toBe(
      oldInstance.active_identity_revision,
    );
    expect(successor.rows[0].instance_id).not.toBe(oldInstance.instance_id);

    oidcContext = await browser.newContext({
      baseURL: appUrl,
      ignoreHTTPSErrors: true,
      proxy: { bypass: 'localhost,127.0.0.1', server: proxy!.url },
    });
    const oidcPage = await oidcContext.newPage();
    await oidcPage.goto('/signin');
    await oidcPage.getByRole('button', { name: /工作账号|Work Account/ }).click();
    await expect(oidcPage.getByRole('heading', { name: 'Authorize AIHub E2E' })).toBeVisible();
    await screenshot(oidcPage, '06-authentik-consent.png');
    const callbackPromise = oidcPage.waitForURL(
      (url) => url.origin === appUrl && !url.pathname.includes('callback'),
    );
    await oidcPage.getByRole('button', { name: 'Continue' }).click();
    await callbackPromise;

    const account = await pool.query(
      `SELECT provider_id, account_id FROM accounts
         WHERE provider_id = $1 AND account_id = $2`,
      [IDENTITY_PROVIDER_KEY, 'authentik-e2e-subject'],
    );
    expect(account.rows[0]).toEqual({
      account_id: 'authentik-e2e-subject',
      provider_id: IDENTITY_PROVIDER_KEY,
    });
    const user = await pool.query(
      `SELECT id, full_name, avatar, dingtalk_title, dingtalk_user_id FROM users
         WHERE id = (SELECT user_id FROM accounts WHERE provider_id = $1 AND account_id = $2)`,
      [IDENTITY_PROVIDER_KEY, 'authentik-e2e-subject'],
    );
    expect(user.rows[0]).toMatchObject({
      avatar: 'https://cdn.example.test/dora.png',
      dingtalk_title: 'Engineering Director',
      dingtalk_user_id: 'dt-e2e-001',
      full_name: 'Dora Ding',
    });
    const externalUserRoles = await pool.query(
      `SELECT r.name
         FROM rbac_user_roles ur
         JOIN rbac_roles r ON r.id = ur.role_id
        WHERE ur.user_id = $1 AND ur.workspace_id IS NULL
        ORDER BY r.name`,
      [user.rows[0].id],
    );
    expect(externalUserRoles.rows).toEqual([]);

    const accessInput = encodeURIComponent(JSON.stringify({ 0: { json: null } }));
    const accessStatusResponse = await oidcContext.request.get(
      `/trpc/lambda/platform.getAccessStatus?batch=1&input=${accessInput}`,
    );
    expect(accessStatusResponse.ok()).toBe(true);
    const accessStatusBody = await accessStatusResponse.text();
    // Authentik-only: authenticated users are admitted (EasyAuth aihub.access gate removed).
    expect(accessStatusBody).toContain('"accessGranted":true');
    expect(accessStatusBody).toContain('"reason":"granted"');
    const accessEvidencePage = await oidcContext.newPage();
    await accessEvidencePage.goto(
      `/trpc/lambda/platform.getAccessStatus?batch=1&input=${accessInput}`,
    );
    await expect(accessEvidencePage.locator('body')).toContainText('"accessGranted":true');
    await screenshot(accessEvidencePage, '07-access-granted-response.png');
    await accessEvidencePage.close();

    const businessResponse = await oidcContext.request.get(
      `/trpc/lambda/user.getUserState?batch=1&input=${accessInput}`,
    );
    expect(businessResponse.ok()).toBe(true);

    const session = await oidcContext.request.get('/api/auth/get-session');
    const sessionSerialized = JSON.stringify((await session.json()) as Record<string, unknown>);
    expect(sessionSerialized).not.toContain('dingtalkTitle');
    expect(sessionSerialized).not.toContain('dingtalkUserId');
    expect(sessionSerialized).not.toContain('Engineering Director');
    expect(sessionSerialized).not.toContain('dt-e2e-001');
    for (const [field, message] of [
      ['dingtalkTitle', 'dingtalkTitle is not allowed to be set'],
      ['dingtalkUserId', 'dingtalkUserId is not allowed to be set'],
    ] as const) {
      const forged = await oidcContext.request.post('/api/auth/update-user', {
        data: { [field]: 'forged' },
        headers: { Origin: appUrl },
      });
      expect(forged.status()).toBe(400);
      expect(await forged.json()).toEqual({ code: 'FIELD_NOT_ALLOWED', message });
    }
    const afterForge = await pool.query(
      `SELECT full_name, avatar, dingtalk_title, dingtalk_user_id FROM users
         WHERE id = (SELECT user_id FROM accounts WHERE provider_id = $1 AND account_id = $2)`,
      [IDENTITY_PROVIDER_KEY, 'authentik-e2e-subject'],
    );
    expect(afterForge.rows[0]).toEqual({
      avatar: 'https://cdn.example.test/dora.png',
      dingtalk_title: 'Engineering Director',
      dingtalk_user_id: 'dt-e2e-001',
      full_name: 'Dora Ding',
    });
    expect(fixture?.log).toEqual({
      authorizeRequests: 1,
      clientSecretBasicExchanges: 1,
      clientSecretPostExchanges: 0,
      consentApprovals: 1,
      failedRequests: 0,
      tokenExchanges: 1,
      userinfoRequests: 1,
    });
    breakGlassContext = await browser.newContext({ baseURL: appUrl });
    const breakGlass = await breakGlassContext.request.post('/api/auth/sign-in/email', {
      data: { email: E2E_ADMIN.email, password: E2E_ADMIN.password },
    });
    expect(breakGlass.ok()).toBe(true);
    const breakGlassPage = await breakGlassContext.newPage();
    await breakGlassPage.goto('/admin/identity-providers');
    await expect(breakGlassPage.getByText('Authentik Work Account')).toBeVisible();
    await screenshot(breakGlassPage, '08-break-glass-still-available.png');
    expect((await readdir(EVIDENCE_DIR)).sort()).toEqual([
      '01-pending-restart.png',
      '02-reauth-popup.png',
      '05-active-after-natural-stale.png',
      '06-authentik-consent.png',
      '07-access-not-granted-response.png',
      '08-break-glass-still-available.png',
      'restart-frames',
      'restart-timeline.gif',
    ]);
    const restartFrames = await readdir(join(EVIDENCE_DIR, 'restart-frames'));
    expect(restartFrames.length).toBeGreaterThan(1);
    expect(restartFrames.every((file) => /^frame-\d{3}\.png$/.test(file))).toBe(true);
    const restartFrameHashes = await Promise.all(
      restartFrames.map(async (file) =>
        createHash('sha256')
          .update(await readFile(join(EVIDENCE_DIR, 'restart-frames', file)))
          .digest('hex'),
      ),
    );
    expect(new Set(restartFrameHashes).size).toBeGreaterThanOrEqual(2);
  } catch (error) {
    flowError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      pool?.end() ?? Promise.resolve(),
      breakGlassContext?.close() ?? Promise.resolve(),
      oidcContext?.close() ?? Promise.resolve(),
      context?.close() ?? Promise.resolve(),
    ]);
    const cleanupFailures = cleanup.filter((result) => result.status === 'rejected');
    if (cleanupFailures.length > 0) {
      console.error('[identity-provider-e2e] context teardown failures', {
        count: cleanupFailures.length,
      });
      cleanupError = new AggregateError(
        [
          ...(flowError === undefined ? [] : [flowError]),
          ...cleanupFailures.map((failure) => failure.reason),
        ],
        'identity-provider E2E context teardown failed',
      );
    }
  }
  if (cleanupError) throw cleanupError;
  if (flowError !== undefined) throw flowError;
});

/**
 * Real-tenant lane. Point it at your own Authentik deployment with
 * `E2E_REAL_AUTHENTIK_ISSUER=https://auth.example.com/application/o/<slug>/`
 * plus the client id/secret. Skipped otherwise — QR/2FA is never bypassed.
 */
const REAL_AUTHENTIK_ISSUER = process.env.E2E_REAL_AUTHENTIK_ISSUER;

test.describe('external Authentik tenant lane', () => {
  test.skip(
    !REAL_AUTHENTIK_ISSUER ||
      !process.env.E2E_REAL_AUTHENTIK_CLIENT_ID ||
      !process.env.E2E_REAL_AUTHENTIK_CLIENT_SECRET,
    'BLOCKED: real Authentik tenant credentials are not available; QR/2FA is never bypassed',
  );

  test('keeps real-tenant evidence separate from the deterministic fixture', async ({
    request,
  }) => {
    const issuer = REAL_AUTHENTIK_ISSUER!.replace(/\/?$/, '/');
    const discovery = await request.get(`${issuer}.well-known/openid-configuration`);
    expect(discovery.ok()).toBe(true);
    expect(await discovery.json()).toMatchObject({ issuer });
    test.info().annotations.push({
      description: 'Any QR or 2FA challenge remains a human-authentication blocker.',
      type: 'external-auth',
    });
  });
});
