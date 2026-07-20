import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

import { Pool } from 'pg';

import {
  cleanupLifecycle,
  createLifecycleState,
  createRunToken,
  type LifecycleState,
  registerProcess,
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

export const freePort = async (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('port unavailable'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });

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

const runCommand = async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
  new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command, args as string[], {
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
 * Start isolated postgres + redis + migrate + app (dev full-stack by default).
 * Entire lifecycle from first docker run is under try/finally ownership cleanup.
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
  let child: ChildProcess | undefined;
  let settled = false;

  const stop = async () => {
    if (settled) return;
    settled = true;
    await cleanupLifecycle(state);
  };

  try {
    const suffix = runToken.replaceAll(/[^a-z0-9-]/gi, '').slice(-24);
    const databaseName = `aihub_admin_${suffix}`;
    const postgresPort = await freePort();
    const redisPort = await freePort();
    const appPort = await freePort();

    await startOwnedContainer({
      args: [
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-e',
        `POSTGRES_DB=${databaseName}`,
        '-p',
        `127.0.0.1:${postgresPort}:5432`,
      ],
      image: 'paradedb/paradedb:latest-pg17',
      name: `aihub-admin-pg-${suffix}`,
      runToken,
      state,
    });
    await startOwnedContainer({
      args: ['-p', `127.0.0.1:${redisPort}:6379`],
      image: 'redis:7-alpine',
      name: `aihub-admin-redis-${suffix}`,
      runToken,
      state,
    });

    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${databaseName}`;
    const redisUrl = `redis://127.0.0.1:${redisPort}`;
    const appUrl = `http://localhost:${appPort}`;
    await waitForPostgres(databaseUrl);

    const env = buildEnterpriseEnv({ appUrl, databaseUrl, port: appPort, redisUrl });
    await runCommand('bun', ['run', 'db:migrate'], { ...env, NODE_ENV: 'agenttest' });

    const mode = (process.env.E2E_ENTERPRISE_ADMIN_MODE as 'dev' | 'start' | undefined) ?? 'dev';

    if (mode === 'start') {
      if (process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD !== '1') {
        await runCommand('bun', ['run', 'build'], {
          ...env,
          NODE_ENV: 'production',
          SKIP_LINT: '1',
        });
      }
      child = spawn(
        process.execPath,
        [
          path.resolve(PROJECT_ROOT, 'node_modules/next/dist/bin/next'),
          'start',
          '-p',
          String(appPort),
        ],
        {
          cwd: PROJECT_ROOT,
          detached: true,
          env: { ...env, NODE_ENV: 'production' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } else {
      child = spawn('bun', ['run', 'dev'], {
        cwd: PROJECT_ROOT,
        detached: true,
        env: {
          ...env,
          SERVER_PORT: String(appPort),
          SPA_PORT: String(await freePort()),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    registerProcess(state, child);
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
