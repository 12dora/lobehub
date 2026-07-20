import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';

import { Pool } from 'pg';

import {
  assertNoOwnedContainersRemain,
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  inspectPublishedHostPort,
  installLifecycleSignalHandlers,
  type LifecycleState,
  spawnOwned,
  startOwnedContainer,
} from './lifecycle';

export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

export interface SuiteRuntime {
  appUrl: string;
  databaseUrl: string;
  mode: 'dev' | 'start' | 'external';
  redisUrl: string;
  runToken: string;
  stop: () => Promise<void>;
}

const AUTH_SECRET = 'enterprise-admin-e2e-auth-secret-at-least-32-chars!';
const KEY_VAULTS_SECRET = 'LA7n9k3JdEcbSgml2sxfw+4TV1AzaaFU5+R176aQz4s=';

/**
 * Hold a listening socket until release() — eliminates freePort TOCTOU for app ports.
 */
export interface HeldPort {
  port: number;
  release: () => Promise<void>;
}

export const holdPort = async (host = '127.0.0.1'): Promise<HeldPort> =>
  new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('port unavailable'));
        return;
      }
      const port = address.port;
      resolve({
        port,
        release: () =>
          new Promise((res, rej) => {
            server.close((error) => (error ? rej(error) : res()));
          }),
      });
    });
  });

/** @deprecated Prefer holdPort / Docker ephemeral publish — kept for unit helpers only. */
export const freePort = async (): Promise<number> => {
  const held = await holdPort();
  await held.release();
  return held.port;
};

const waitForPostgres = async (url: string) => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 1500 });
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error('isolated PostgreSQL failed to start within 90s');
};

/**
 * Run a one-shot command as a detached process group registered on the lifecycle.
 */
export const runOwnedCommand = async (
  state: LifecycleState,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolveCommand, reject) => {
    const child = spawnOwned(state, command, args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      // Drop from process list once exited so cleanup does not re-kill.
      const idx = state.processes.indexOf(child);
      if (idx >= 0) state.processes.splice(idx, 1);
      if (code === 0) return resolveCommand();
      reject(new Error(`${command} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
  });

const waitForHttp = async (
  url: string,
  timeoutMs = 180_000,
  accept: (status: number) => boolean = (status) => status >= 200 && status < 400,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (accept(response.status)) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`app health check failed: ${url}`);
};

export const buildEnterpriseEnv = (params: {
  appUrl: string;
  databaseUrl: string;
  port: number;
  redisUrl: string;
}): NodeJS.ProcessEnv => ({
  ...process.env,
  APP_URL: params.appUrl,
  AUTH_EMAIL_VERIFICATION: '0',
  AUTH_SECRET,
  AUTH_TRUSTED_ORIGINS: `${params.appUrl},http://127.0.0.1:${params.port},http://localhost:${params.port}`,
  DATABASE_DRIVER: 'node',
  DATABASE_URL: params.databaseUrl,
  EASYAUTH_APP_TOKEN: '',
  EASYAUTH_APP_TOKEN_FILE: '/dev/null',
  EASYAUTH_BASE_URL: 'http://127.0.0.1:9',
  EASYAUTH_PORTAL_URL: 'http://127.0.0.1:9',
  ENABLE_PLATFORM_ADMIN: '1',
  ENABLE_PLATFORM_MANAGED_AGENTS: '1',
  ENABLE_PLATFORM_MANAGED_AI: '1',
  ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
  ENABLE_PLATFORM_MANAGED_SKILLS: '1',
  ENABLE_PLATFORM_SETTINGS_POLICY: '1',
  FEATURE_FLAGS: '-agent_self_iteration',
  KEY_VAULTS_SECRET,
  NODE_OPTIONS: '--max-old-space-size=6144',
  // Short config cache so skill-catalog readiness outage becomes observable quickly.
  PLATFORM_CONFIG_CACHE_TTL_SECONDS: '1',
  PLATFORM_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  PLATFORM_MASTER_KEY_ID: 'enterprise-admin-e2e-key',
  PORT: String(params.port),
  REDIS_URL: params.redisUrl,
  S3_ACCESS_KEY_ID: 'e2e-placeholder',
  S3_BUCKET: 'e2e-placeholder',
  S3_ENDPOINT: 'https://s3.invalid',
  S3_SECRET_ACCESS_KEY: 'e2e-placeholder',
});

/**
 * External mode requires BOTH:
 * - E2E_ENTERPRISE_ADMIN_EXTERNAL=1
 * - E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB=1
 * BASE_URL alone never selects external mode (prevents accidental shared-DB mutation).
 */
export const resolveRuntimeMode = (
  env: NodeJS.ProcessEnv = process.env,
): 'isolated' | 'external' => {
  if (env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1') {
    if (env.E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB !== '1') {
      throw new Error(
        'external mode blocked: set E2E_ENTERPRISE_ADMIN_DISPOSABLE_DB=1 only for a disposable database you own',
      );
    }
    if (!env.BASE_URL || !env.DATABASE_URL) {
      throw new Error('external mode requires BASE_URL and DATABASE_URL');
    }
    return 'external';
  }
  // BASE_URL without explicit external gate is ignored — always isolate.
  return 'isolated';
};

/**
 * Start app process with held-port reservation + bounded retry on EADDRINUSE.
 */
const startAppWithPortRetry = async (params: {
  databaseUrl: string;
  mode: 'dev' | 'start';
  redisUrl: string;
  state: LifecycleState;
  attempts?: number;
}): Promise<{ appPort: number; appUrl: string; child: ChildProcess }> => {
  const maxAttempts = params.attempts ?? 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const heldApp = await holdPort();
    const heldSpa = params.mode === 'dev' ? await holdPort() : undefined;
    const appPort = heldApp.port;
    const spaPort = heldSpa?.port;
    const appUrl = `http://localhost:${appPort}`;
    const env = buildEnterpriseEnv({
      appUrl,
      databaseUrl: params.databaseUrl,
      port: appPort,
      redisUrl: params.redisUrl,
    });
    try {
      await heldApp.release();
      if (heldSpa) await heldSpa.release();

      let child: ChildProcess;
      if (params.mode === 'start') {
        child = spawnOwned(
          params.state,
          process.execPath,
          [
            path.resolve(PROJECT_ROOT, 'node_modules/next/dist/bin/next'),
            'start',
            '-p',
            String(appPort),
          ],
          {
            cwd: PROJECT_ROOT,
            env: { ...env, NODE_ENV: 'production' },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
      } else {
        child = spawnOwned(params.state, 'bun', ['run', 'dev'], {
          cwd: PROJECT_ROOT,
          env: {
            ...env,
            SERVER_PORT: String(appPort),
            SPA_PORT: String(spaPort),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }

      // Detect immediate bind failure
      const earlyExit = await Promise.race([
        new Promise<'alive'>((r) => setTimeout(() => r('alive'), 800)),
        new Promise<'dead'>((r) => child.once('exit', () => r('dead'))),
      ]);
      if (earlyExit === 'dead') {
        const idx = params.state.processes.indexOf(child);
        if (idx >= 0) params.state.processes.splice(idx, 1);
        lastError = new Error(`app exited immediately on port ${appPort}`);
        continue;
      }
      return { appPort, appUrl, child };
    } catch (error) {
      lastError = error;
      await heldApp.release().catch(() => undefined);
      await heldSpa?.release().catch(() => undefined);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`failed to bind app port after ${maxAttempts} attempts`);
};

/** Injected fault stages for unit/fault tests (never set in production runs). */
export type StartupFaultStage =
  'after-postgres' | 'after-redis' | 'after-migrate' | 'after-build' | 'after-app-spawn';

const maybeInjectFault = (stage: StartupFaultStage, runToken: string): void => {
  if (process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE === stage) {
    const error = new Error(`injected startup fault at ${stage}`) as Error & {
      runToken?: string;
    };
    error.runToken = runToken;
    throw error;
  }
};

/**
 * Start isolated postgres + redis + migrate + app (dev full-stack by default).
 * Lifecycle owner + signal handlers installed before first docker run.
 * Docker publishes ephemeral host ports (no freePort TOCTOU).
 */
export const startEnterpriseAdminRuntime = async (): Promise<SuiteRuntime> => {
  const modeChoice = resolveRuntimeMode();
  if (modeChoice === 'external') {
    const appUrl = process.env.BASE_URL!.replace(/\/$/, '');
    const databaseUrl = process.env.DATABASE_URL!;
    await waitForHttp(`${appUrl}/signin`, 30_000);
    return {
      appUrl,
      databaseUrl,
      mode: 'external',
      redisUrl: process.env.REDIS_URL || '',
      runToken: 'external',
      stop: async () => undefined,
    };
  }

  const runToken = createRunToken();
  const state: LifecycleState = createLifecycleState(runToken);
  // Signal owner before first resource acquisition.
  installLifecycleSignalHandlers(state);
  let settled = false;

  const stop = async () => {
    if (settled) return;
    settled = true;
    try {
      await cleanupLifecycle(state);
    } finally {
      await assertNoOwnedContainersRemain(runToken).catch((error) => {
        console.error('[lifecycle] post-cleanup leftover check failed', error);
        throw error;
      });
    }
  };

  try {
    const suffix = runToken.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
    const databaseName = `aihub_admin_${suffix}`;

    // Docker assigns host ports — no freePort race with parallel suites.
    const pg = await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        `POSTGRES_DB=${databaseName}`,
        '-p',
        '127.0.0.1::5432',
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-pg-${suffix}`,
      runToken,
      state,
    });
    maybeInjectFault('after-postgres', runToken);

    const redis = await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-redis-${suffix}`,
      runToken,
      state,
    });
    maybeInjectFault('after-redis', runToken);

    const postgresPort = await inspectPublishedHostPort(pg.id, 5432);
    const redisPort = await inspectPublishedHostPort(redis.id, 6379);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${databaseName}`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    await waitForPostgres(databaseUrl);

    // Temporary env for migrate (port placeholder; migrate does not listen).
    const migrateEnv = buildEnterpriseEnv({
      appUrl: 'http://localhost:9',
      databaseUrl,
      port: 9,
      redisUrl,
    });
    await runOwnedCommand(state, 'bun', ['run', 'db:migrate'], {
      ...migrateEnv,
      NODE_ENV: 'agenttest',
    });
    maybeInjectFault('after-migrate', runToken);

    const mode = (process.env.E2E_ENTERPRISE_ADMIN_MODE as 'dev' | 'start' | undefined) ?? 'dev';

    if (mode === 'start' && process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD !== '1') {
      await runOwnedCommand(state, 'bun', ['run', 'build'], {
        ...migrateEnv,
        NODE_ENV: 'production',
        SKIP_LINT: '1',
      });
      maybeInjectFault('after-build', runToken);
    }

    const { appUrl, child } = await startAppWithPortRetry({
      databaseUrl,
      mode,
      redisUrl,
      state,
    });
    maybeInjectFault('after-app-spawn', runToken);

    child.stdout?.on('data', (chunk) => process.stdout.write(`[admin-e2e-app] ${chunk}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(`[admin-e2e-app] ${chunk}`));
    child.once('exit', (code, signal) => {
      console.error(`[admin-e2e-app] exited code=${code} signal=${signal}`);
    });

    await waitForHttp(`${appUrl}/signin`, 240_000, (status) => status === 200);
    const prewarmInput = encodeURIComponent(JSON.stringify({ 0: { json: null } }));
    await waitForHttp(
      `${appUrl}/trpc/lambda/platform.getPublicSnapshot?batch=1&input=${prewarmInput}`,
      180_000,
      (status) => status === 200,
    );

    return {
      appUrl,
      databaseUrl,
      mode,
      redisUrl,
      runToken,
      stop,
    };
  } catch (error) {
    await stop().catch((cleanupError) => {
      throw new AggregateError(
        [error, cleanupError],
        'enterprise-admin runtime start failed and cleanup failed',
      );
    });
    throw error;
  }
};
