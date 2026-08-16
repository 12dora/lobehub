/**
 * Startup platform bootstrap — the in-image counterpart of the standalone
 * `superAdmin.ts` script, so a Docker-only deployer never needs a repo checkout.
 *
 * Runs from the Next.js `instrumentation.register()` hook (the same place the
 * identity-provider runtime boots) and does two idempotent things:
 *
 *  1. `ensurePlatformRbacSeeded` — upserts every `platform_*` permission code and
 *     re-syncs the system-role → permission mappings. This is what makes
 *     permissions added by a new release appear in an already-migrated database.
 *  2. Optional super-admin bootstrap, driven by the same `BOOTSTRAP_*` env vars
 *     the CLI script accepts. Promotes an existing user, or (with
 *     `BOOTSTRAP_ALLOW_CREATE=1`) creates a local break-glass account and prints
 *     the generated one-time password exactly once.
 *
 * Safety rules:
 *  - never runs when `ENABLE_PLATFORM_ADMIN` (alias `ENABLE_ENTERPRISE_ADMIN`) is off;
 *  - never runs during `next build`;
 *  - never throws — a failure is logged and the server keeps booting;
 *  - idempotent across restarts: the second boot finds the user and reports
 *    `alreadySuperAdmin`, so no password is ever printed twice.
 */
import { PHASE_PRODUCTION_BUILD } from 'next/constants';

import type { LobeChatDatabase } from '@/database/type';

import { parseEnterpriseFeatureFlags } from '../featureFlags';
import {
  bootstrapSuperAdmin,
  type BootstrapSuperAdminResult,
  ensurePlatformRbacSeeded,
} from './superAdmin';

export type StartupBootstrapEnv = Record<string, string | undefined>;

export type StartupBootstrapOutcome =
  | { reason: 'build-phase' | 'no-database-url' | 'platform-admin-disabled'; status: 'skipped' }
  | { status: 'seeded'; superAdminCount: number }
  | { result: BootstrapSuperAdminResult; status: 'bootstrapped' }
  | { errorCategory: string; status: 'failed' };

const LOG_PREFIX = '[platformBootstrap]';

const classifyError = (error: unknown): string =>
  error instanceof Error ? error.name || 'Error' : 'UnknownError';

/** Printed once, only when the bootstrap itself generated the password. */
const printOneTimePassword = (params: {
  createdUser: boolean;
  identity: string;
  password: string;
  userId: string;
}): void => {
  const rule = '='.repeat(72);
  console.warn(
    [
      '',
      rule,
      params.createdUser
        ? '  Break-glass super admin CREATED'
        : '  Break-glass credential REPAIRED for super admin',
      `    sign-in id : ${params.identity}`,
      `    user id    : ${params.userId}`,
      `    password   : ${params.password}`,
      '  This one-time password is printed ONCE and is not recoverable.',
      '  Sign in and change it immediately.',
      rule,
      '',
    ].join('\n'),
  );
};

/**
 * Seed platform RBAC and, when `BOOTSTRAP_SUPER_ADMIN_*` is configured, run the
 * super-admin bootstrap. Never throws.
 */
export const runStartupPlatformBootstrap = async (
  db: LobeChatDatabase,
  env: StartupBootstrapEnv,
): Promise<StartupBootstrapOutcome> => {
  try {
    const { superAdminCount } = await ensurePlatformRbacSeeded(db);

    const userId = env.BOOTSTRAP_SUPER_ADMIN_USER_ID?.trim() || null;
    const email = env.BOOTSTRAP_SUPER_ADMIN_EMAIL?.trim() || null;

    if (!userId && !email) {
      console.info(`${LOG_PREFIX} platform RBAC seeded`, { superAdminCount });
      return { status: 'seeded', superAdminCount };
    }

    const result = await bootstrapSuperAdmin(db, {
      allowCreate: env.BOOTSTRAP_ALLOW_CREATE === '1',
      email,
      password: env.BOOTSTRAP_SUPER_ADMIN_PASSWORD,
      repairCredential: env.BOOTSTRAP_REPAIR_CREDENTIAL === '1',
      userId,
      username: env.BOOTSTRAP_SUPER_ADMIN_USERNAME,
    });

    console.info(`${LOG_PREFIX} super admin bootstrap complete`, {
      alreadySuperAdmin: result.alreadySuperAdmin,
      createdUser: result.createdUser,
      credentialRepaired: result.credentialRepaired,
      roleAssigned: result.roleAssigned,
      userId: result.userId,
    });

    if (result.oneTimePassword) {
      printOneTimePassword({
        createdUser: result.createdUser,
        identity: email ?? result.userId,
        password: result.oneTimePassword,
        userId: result.userId,
      });
    }

    return { result, status: 'bootstrapped' };
  } catch (error) {
    // Never block server startup — an operator can always re-run the CLI script.
    const errorCategory = classifyError(error);
    console.error(`${LOG_PREFIX} startup bootstrap failed (non-blocking)`, {
      errorCategory,
      message: error instanceof Error ? error.message : String(error),
    });
    return { errorCategory, status: 'failed' };
  }
};

const bootstrapProcess = process as NodeJS.Process & {
  __lobehubPlatformBootstrapPromise?: Promise<StartupBootstrapOutcome>;
};

/**
 * Process-wide, run-once entry used by `instrumentation.register()`.
 * Resolves the server database lazily so a disabled deployment never touches it.
 */
export const bootstrapPlatformAdminRuntime = (
  env: StartupBootstrapEnv = process.env,
): Promise<StartupBootstrapOutcome> => {
  bootstrapProcess.__lobehubPlatformBootstrapPromise ??= (async () => {
    if (env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
      return { reason: 'build-phase', status: 'skipped' } as const;
    }
    if (!parseEnterpriseFeatureFlags(env).ENABLE_PLATFORM_ADMIN) {
      return { reason: 'platform-admin-disabled', status: 'skipped' } as const;
    }
    if (!env.DATABASE_URL) {
      return { reason: 'no-database-url', status: 'skipped' } as const;
    }

    try {
      const { getServerDB } = await import('@/database/core/db-adaptor');
      const db = await getServerDB();
      return await runStartupPlatformBootstrap(db, env);
    } catch (error) {
      const errorCategory = classifyError(error);
      console.error(`${LOG_PREFIX} database unavailable at startup (non-blocking)`, {
        errorCategory,
      });
      return { errorCategory, status: 'failed' } as const;
    }
  })();

  return bootstrapProcess.__lobehubPlatformBootstrapPromise;
};

export const resetPlatformBootstrapForTest = (): void => {
  delete bootstrapProcess.__lobehubPlatformBootstrapPromise;
};
