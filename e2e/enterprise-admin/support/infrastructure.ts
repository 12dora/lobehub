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
  type LifecycleEvidence,
  type LifecycleState,
  refreshOwnedProcessGroupEvidence,
  registerOwnedDir,
  registerOwnedPort,
  snapshotLifecycleEvidence,
  spawnOwned,
  startOwnedContainer,
} from './lifecycle';

export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

export interface SuiteRuntime {
  appUrl: string;
  databaseUrl: string;
  lifecycle: LifecycleState;
  mode: 'dev' | 'start' | 'external';
  /** Isolated Next distDir relative to project root (owned; cleaned on stop). */
  nextDistDir?: string;
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

export type StartupFaultError = Error & {
  lifecycleEvidenceAfter?: LifecycleEvidence;
  lifecycleEvidenceBefore?: LifecycleEvidence;
  runToken?: string;
};

/** @deprecated Prefer holdPort / Docker ephemeral publish — kept for unit helpers only. */
export const freePort = async (): Promise<number> => {
  const held = await holdPort();
  await held.release();
  return held.port;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
      await sleep(500);
    }
  }
  throw new Error('isolated PostgreSQL failed to start within 90s');
};

/**
 * Run a one-shot command as a detached process group registered on the lifecycle.
 * While running, refresh process-group descendant evidence (narrow pgrep -g only).
 */
export const runOwnedCommand = async (
  state: LifecycleState,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> => {
  const child = spawnOwned(state, command, args, {
    cwd: PROJECT_ROOT,
    env,
    stdio: 'inherit',
  });

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const stopPoll = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const startPoll = () => {
    const leader = child.pid;
    if (!leader) return;
    pollTimer = setInterval(() => {
      void refreshOwnedProcessGroupEvidence(state, leader);
    }, 250);
    if (typeof pollTimer === 'object' && 'unref' in pollTimer) {
      (pollTimer as { unref: () => void }).unref();
    }
    void refreshOwnedProcessGroupEvidence(state, leader);
  };
  if (child.pid) startPoll();
  else child.once('spawn', startPoll);

  try {
    await new Promise<void>((resolveCommand, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        const idx = state.processes.indexOf(child);
        if (idx >= 0) state.processes.splice(idx, 1);
        // Final group snapshot before members fully reap (best-effort).
        if (child.pid) void refreshOwnedProcessGroupEvidence(state, child.pid);
        if (code === 0) return resolveCommand();
        reject(new Error(`${command} failed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
      });
    });
  } finally {
    stopPoll();
  }
};

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
    await sleep(750);
  }
  throw new Error(`app health check failed: ${url}`);
};

export const buildEnterpriseEnv = (params: {
  appUrl: string;
  databaseUrl: string;
  nextDistDir?: string;
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
  // Isolate Next output so suite never corrupts the user's main .next (type-check safe).
  ...(params.nextDistDir ? { E2E_ENTERPRISE_ADMIN_NEXT_DIST_DIR: params.nextDistDir } : {}),
  ENABLE_PLATFORM_ADMIN: '1',
  ENABLE_PLATFORM_MANAGED_AGENTS: '1',
  ENABLE_PLATFORM_MANAGED_AI: '1',
  ENABLE_PLATFORM_MANAGED_CONNECTORS: '1',
  ENABLE_PLATFORM_MANAGED_SKILLS: '1',
  ENABLE_PLATFORM_SETTINGS_POLICY: '1',
  FEATURE_FLAGS: '-agent_self_iteration',
  KEY_VAULTS_SECRET,
  NODE_OPTIONS: '--max-old-space-size=6144',
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
  return 'isolated';
};

export type StartAppHooks = {
  /**
   * Called after ports are released and before spawn (tests inject competitors / delay).
   * Production path leaves this undefined.
   */
  afterPortRelease?: (ports: { appPort: number; spaPort?: number }) => Promise<void> | void;
  /** Artificial delay after release before spawn (deterministic TOCTOU regression). */
  bindDelayMs?: number;
  /** How long to probe for bind failure before accepting the spawn attempt. */
  bindProbeTimeoutMs?: number;
  /** Observer: each spawn attempt (does not alter cleanup). */
  onSpawn?: (child: ChildProcess, attempt: number) => void;
  /** Observer: after a failed attempt is fully reaped. */
  onAttemptFailed?: (child: ChildProcess, attempt: number) => void;
  /**
   * Test seam: spawn a controlled app process through the same orchestration as production.
   * When omitted, production next/bun spawn is used.
   */
  spawnApp?: (args: {
    appPort: number;
    env: NodeJS.ProcessEnv;
    spaPort?: number;
    state: LifecycleState;
  }) => ChildProcess;
};

const killOwnedChild = async (state: LifecycleState, child: ChildProcess): Promise<void> => {
  const idx = state.processes.indexOf(child);
  if (idx >= 0) state.processes.splice(idx, 1);
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // gone
    }
  }
  await Promise.race([new Promise<void>((r) => child.once('exit', () => r())), sleep(2_000)]);
};

/**
 * Probe spawn for bind failure (EADDRINUSE / early exit) without requiring full HTTP ready.
 * Delayed bind failures beyond 800ms are still detected for the full probe window.
 * A port held by a competitor is NOT treated as success — only child exit / EADDRINUSE fail,
 * and surviving the full window without those means "spawn looks stable" (outer health wait decides).
 */
export const probeAppBindOrFail = async (params: {
  appPort: number;
  child: ChildProcess;
  timeoutMs: number;
}): Promise<void> => {
  let stderr = '';
  let stdout = '';
  const onErr = (chunk: Buffer | string) => {
    stderr += String(chunk);
  };
  const onOut = (chunk: Buffer | string) => {
    stdout += String(chunk);
  };
  params.child.stderr?.on('data', onErr);
  params.child.stdout?.on('data', onOut);

  const deadline = Date.now() + params.timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (params.child.exitCode !== null || params.child.signalCode !== null) {
        throw new Error(
          `app exited before bind stable (code=${params.child.exitCode} signal=${params.child.signalCode}): ${stderr.slice(-500)}`,
        );
      }
      const combined = `${stderr}\n${stdout}`;
      if (/EADDRINUSE|address already in use/i.test(combined)) {
        throw new Error(`app bind EADDRINUSE: ${combined.slice(-400)}`);
      }
      await sleep(100);
    }
    // Still alive without EADDRINUSE for the full probe window — accept.
    // (Port may not be listening yet; outer waitForHttp covers readiness.)
  } finally {
    params.child.stderr?.off('data', onErr);
    params.child.stdout?.off('data', onOut);
  }
};

/**
 * Start app with held-port reservation + bounded choose/start/retry.
 * On EADDRINUSE / late bind failure: kill owned group, choose new ports, restart promptly.
 */
export const startAppWithPortRetry = async (params: {
  databaseUrl: string;
  hooks?: StartAppHooks;
  mode: 'dev' | 'start';
  nextDistDir?: string;
  redisUrl: string;
  state: LifecycleState;
  attempts?: number;
}): Promise<{ appPort: number; appUrl: string; child: ChildProcess }> => {
  const maxAttempts = params.attempts ?? 5;
  const bindProbeTimeoutMs = params.hooks?.bindProbeTimeoutMs ?? 4_000;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const heldApp = await holdPort();
    const heldSpa = params.mode === 'dev' ? await holdPort() : undefined;
    const appPort = heldApp.port;
    const spaPort = heldSpa?.port;
    registerOwnedPort(params.state, appPort);
    if (spaPort) registerOwnedPort(params.state, spaPort);
    const appUrl = `http://localhost:${appPort}`;
    const env = buildEnterpriseEnv({
      appUrl,
      databaseUrl: params.databaseUrl,
      nextDistDir: params.nextDistDir,
      port: appPort,
      redisUrl: params.redisUrl,
    });

    try {
      await heldApp.release();
      if (heldSpa) await heldSpa.release();

      if (params.hooks?.afterPortRelease) {
        await params.hooks.afterPortRelease({ appPort, spaPort });
      }
      if (params.hooks?.bindDelayMs && params.hooks.bindDelayMs > 0) {
        await sleep(params.hooks.bindDelayMs);
      }

      let child: ChildProcess;
      if (params.hooks?.spawnApp) {
        child = params.hooks.spawnApp({
          appPort,
          env: { ...env, PORT: String(appPort) },
          spaPort,
          state: params.state,
        });
      } else if (params.mode === 'start') {
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
      params.hooks?.onSpawn?.(child, attempt);

      try {
        await probeAppBindOrFail({
          appPort,
          child,
          timeoutMs: bindProbeTimeoutMs,
        });
        return { appPort, appUrl, child };
      } catch (error) {
        lastError = error;
        await killOwnedChild(params.state, child);
        params.hooks?.onAttemptFailed?.(child, attempt);
        continue;
      }
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

const maybeInjectFault = (
  stage: StartupFaultStage,
  runToken: string,
  state?: LifecycleState,
): void => {
  if (process.env.E2E_ENTERPRISE_ADMIN_FAULT_STAGE === stage) {
    const error = new Error(`injected startup fault at ${stage}`) as StartupFaultError;
    error.runToken = runToken;
    if (state) {
      error.lifecycleEvidenceBefore = snapshotLifecycleEvidence(state);
    }
    throw error;
  }
};

/**
 * Start isolated postgres + redis + migrate + app (dev full-stack by default).
 * Lifecycle owner + signal handlers installed before first docker run.
 * Docker publishes ephemeral host ports (no freePort TOCTOU).
 * Next distDir is suite-owned and cleaned on stop (never touches main .next).
 */
export const startEnterpriseAdminRuntime = async (): Promise<SuiteRuntime> => {
  const modeChoice = resolveRuntimeMode();
  if (modeChoice === 'external') {
    const appUrl = process.env.BASE_URL!.replace(/\/$/, '');
    const databaseUrl = process.env.DATABASE_URL!;
    await waitForHttp(`${appUrl}/signin`, 30_000);
    const lifecycle = createLifecycleState('external');
    return {
      appUrl,
      databaseUrl,
      lifecycle,
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
    const nextDistDir = `.next-e2e-admin-${suffix}`;
    const nextDistAbs = path.join(PROJECT_ROOT, nextDistDir);
    registerOwnedDir(state, nextDistAbs);

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
    maybeInjectFault('after-postgres', runToken, state);

    const redis = await startOwnedContainer({
      args: ['-p', '127.0.0.1::6379'],
      image: 'redis:7-alpine',
      name: `aihub-admin-redis-${suffix}`,
      runToken,
      state,
    });
    maybeInjectFault('after-redis', runToken, state);

    const postgresPort = await inspectPublishedHostPort(pg.id, 5432);
    const redisPort = await inspectPublishedHostPort(redis.id, 6379);
    registerOwnedPort(state, postgresPort);
    registerOwnedPort(state, redisPort);
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${databaseName}`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    await waitForPostgres(databaseUrl);

    const migrateEnv = buildEnterpriseEnv({
      appUrl: 'http://localhost:9',
      databaseUrl,
      nextDistDir,
      port: 9,
      redisUrl,
    });
    await runOwnedCommand(state, 'bun', ['run', 'db:migrate'], {
      ...migrateEnv,
      NODE_ENV: 'agenttest',
    });
    maybeInjectFault('after-migrate', runToken, state);

    const mode = (process.env.E2E_ENTERPRISE_ADMIN_MODE as 'dev' | 'start' | undefined) ?? 'dev';

    if (mode === 'start') {
      // Production default build only. SKIP_BUILD is for local start-mode convenience of
      // non-after-build paths; after-build fault tests must not set it.
      if (process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD !== '1') {
        // Never touch the user's global `.next/lock`. Operate only on the owned distDir
        // (and its own lock if Next creates one under the isolated path).
        await import('node:fs/promises').then(({ rm }) =>
          rm(path.join(nextDistAbs, 'lock'), { force: true }),
        );
        await runOwnedCommand(state, 'bun', ['run', 'build'], {
          ...migrateEnv,
          NODE_ENV: 'production',
          SKIP_LINT: '1',
        });
      }
      maybeInjectFault('after-build', runToken, state);
    }

    const { appUrl, child } = await startAppWithPortRetry({
      databaseUrl,
      mode,
      nextDistDir,
      redisUrl,
      state,
    });
    maybeInjectFault('after-app-spawn', runToken, state);

    child.stdout?.on('data', (chunk) => process.stdout.write(`[admin-e2e-app] ${chunk}`));
    child.stderr?.on('data', (chunk) => process.stderr.write(`[admin-e2e-app] ${chunk}`));
    child.once('exit', (code, signal) => {
      console.error(`[admin-e2e-app] exited code=${code} signal=${signal}`);
    });

    // Full suite health (already had short readiness during bind).
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
      lifecycle: state,
      mode,
      nextDistDir,
      redisUrl,
      runToken,
      stop,
    };
  } catch (error) {
    const before =
      error && typeof error === 'object' && 'lifecycleEvidenceBefore' in error
        ? (error as StartupFaultError).lifecycleEvidenceBefore
        : snapshotLifecycleEvidence(state);
    await stop().catch((cleanupError) => {
      const after = snapshotLifecycleEvidence(state);
      const aggregate = new AggregateError(
        [error, cleanupError],
        'enterprise-admin runtime start failed and cleanup failed',
      ) as AggregateError & StartupFaultError;
      aggregate.runToken = runToken;
      aggregate.lifecycleEvidenceBefore = before;
      aggregate.lifecycleEvidenceAfter = after;
      throw aggregate;
    });
    if (error && typeof error === 'object') {
      (error as StartupFaultError).runToken = runToken;
      (error as StartupFaultError).lifecycleEvidenceBefore = before;
      (error as StartupFaultError).lifecycleEvidenceAfter = snapshotLifecycleEvidence(state);
    }
    throw error;
  }
};
