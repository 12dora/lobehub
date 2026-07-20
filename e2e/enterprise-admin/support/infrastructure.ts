import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import { Pool } from 'pg';

const execute = promisify(execFile);
export const PROJECT_ROOT = path.resolve(__dirname, '../../..');

export interface ContainerHandle {
  name: string;
}

export interface SuiteRuntime {
  appUrl: string;
  databaseUrl: string;
  mode: 'dev' | 'start' | 'external';
  postgres?: ContainerHandle;
  redis?: ContainerHandle;
  redisUrl: string;
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

const waitForHttp = async (url: string, timeoutMs = 180_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status > 0 && response.status < 500) return;
    } catch {
      // booting
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(`app health check failed: ${url}`);
};

const terminateTree = (child: ChildProcess | undefined) => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
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
  AUTH_TRUSTED_ORIGINS: params.appUrl,
  DATABASE_DRIVER: 'node',
  DATABASE_URL: params.databaseUrl,
  // Keep EasyAuth offline: no token file, closed loopback base (fail-fast, no prod IAM).
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
  // Deterministic local KEK for enterprise secret-dependent readiness probes (not a production secret).
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
 * Start isolated postgres + redis + migrate + app (dev full-stack by default).
 * External mode reuses BASE_URL + DATABASE_URL (caller owns lifecycle).
 */
export const startEnterpriseAdminRuntime = async (): Promise<SuiteRuntime> => {
  if (process.env.E2E_ENTERPRISE_ADMIN_EXTERNAL === '1' || process.env.BASE_URL) {
    const appUrl = process.env.BASE_URL;
    const databaseUrl = process.env.DATABASE_URL;
    if (!appUrl || !databaseUrl) {
      throw new Error(
        'external mode requires BASE_URL and DATABASE_URL (missing env is blocked, not skipped)',
      );
    }
    await waitForHttp(`${appUrl.replace(/\/$/, '')}/signin`, 30_000);
    return {
      appUrl: appUrl.replace(/\/$/, ''),
      databaseUrl,
      mode: 'external',
      redisUrl: process.env.REDIS_URL || '',
      stop: async () => undefined,
    };
  }

  const suffix = `${process.pid}-${Date.now()}`;
  const databaseName = `aihub_admin_${suffix.replaceAll('-', '_')}`;
  const postgresPort = await freePort();
  const redisPort = await freePort();
  const appPort = await freePort();
  const postgres = await startContainer({
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
  });
  const redis = await startContainer({
    args: ['-p', `127.0.0.1:${redisPort}:6379`],
    image: 'redis:7-alpine',
    name: `aihub-admin-redis-${suffix}`,
  });
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${postgresPort}/${databaseName}`;
  const redisUrl = `redis://127.0.0.1:${redisPort}`;
  // Prefer localhost so better-auth cookie + Next host stay consistent with the dev server banner.
  const appUrl = `http://localhost:${appPort}`;
  await waitForPostgres(databaseUrl);

  const env = buildEnterpriseEnv({ appUrl, databaseUrl, port: appPort, redisUrl });
  await runCommand('bun', ['run', 'db:migrate'], { ...env, NODE_ENV: 'agenttest' });

  const mode = (process.env.E2E_ENTERPRISE_ADMIN_MODE as 'dev' | 'start' | undefined) ?? 'dev';
  let child: ChildProcess | undefined;

  if (mode === 'start') {
    if (process.env.E2E_ENTERPRISE_ADMIN_SKIP_BUILD !== '1') {
      await runCommand('bun', ['run', 'build'], { ...env, NODE_ENV: 'production', SKIP_LINT: '1' });
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
    // Full-stack SPA + Next (admin shell is SPA).
    child = spawn('bun', ['run', 'dev'], {
      cwd: PROJECT_ROOT,
      detached: true,
      env: {
        ...env,
        // Pin SPA proxy targets to free ports alongside the app port.
        SERVER_PORT: String(appPort),
        SPA_PORT: String(await freePort()),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  child.stdout?.on('data', (chunk) => process.stdout.write(`[admin-e2e-app] ${chunk}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[admin-e2e-app] ${chunk}`));
  child.once('exit', (code, signal) => {
    console.error(`[admin-e2e-app] exited code=${code} signal=${signal}`);
  });

  try {
    await waitForHttp(`${appUrl}/signin`, 240_000);
    // Cold-compile the lambda tRPC route once so scenario requests do not burn the 20s action budget.
    const prewarmInput = encodeURIComponent(JSON.stringify({ 0: { json: null } }));
    await waitForHttp(
      `${appUrl}/trpc/lambda/platform.getPublicSnapshot?batch=1&input=${prewarmInput}`,
      180_000,
    ).catch(() => undefined);
  } catch (error) {
    terminateTree(child);
    await stopContainer(redis);
    await stopContainer(postgres);
    throw error;
  }

  return {
    appUrl,
    databaseUrl,
    mode,
    postgres,
    redis,
    redisUrl,
    stop: async () => {
      terminateTree(child);
      await new Promise((r) => setTimeout(r, 500));
      await stopContainer(redis);
      await stopContainer(postgres);
    },
  };
};
