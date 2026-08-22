import { max, sql } from 'drizzle-orm';

import { platformSandboxPackageInstalls } from '@/database/schemas/platform';
import type { SandboxPackageInstallManager } from '@/database/schemas/platform/sandboxPackageInstalls';
import type { LobeChatDatabase } from '@/database/type';
import { normalizeSandboxPackageName } from '@/server/services/sandbox/packageLedger';
import { SANDBOX_PREINSTALLED_PIP_PACKAGES } from '@/server/services/sandbox/preinstalled';

import type { AdminSystemGetSandboxPackageStatsOutput } from '../../contracts/adminSystem';

/**
 * What `Dockerfile.sandbox` already ships, per package manager.
 *
 * "Preinstalled" is a claim about ONE manager's namespace: `curl` is in the image as an apt
 * package and says nothing about an npm package of the same name. Checking every row against the
 * pip list alone therefore labelled every apt and npm install a "candidate" — including the five
 * apt packages and the one npm package the image demonstrably already carries.
 *
 * apt: the `apt-get install --no-install-recommends` block, minus `xz-utils`, which the same layer
 * purges after unpacking Node. npm: the single `npm install -g` line. The pip list is the shared
 * constant the sandbox runtime uses.
 */
const SANDBOX_PREINSTALLED_BY_MANAGER: Record<SandboxPackageInstallManager, readonly string[]> = {
  apt: ['build-essential', 'ca-certificates', 'curl', 'git', 'unzip'],
  npm: ['tsx'],
  pip: SANDBOX_PREINSTALLED_PIP_PACKAGES,
};

/** Every name the image ships, in one list — what the card's "n preinstalled" summary counts. */
const SANDBOX_PREINSTALLED_ALL = Object.values(SANDBOX_PREINSTALLED_BY_MANAGER)
  .flat()
  .toSorted((a, b) => a.localeCompare(b));

export interface GetSandboxPackageStatsInput {
  days?: number;
  limit?: number;
}

/**
 * Aggregate sandbox package-install ledger rows for the admin console.
 *
 * `installs` is `sum(install_count)` over rows whose `last_at` falls in the
 * window. `install_count` itself is a lifetime accumulator on the row, so a
 * package last seen inside the window can contribute invocations that happened
 * before the window opened. That is intentional: we do not store per-event
 * timestamps, only the running total.
 */
export const getSandboxPackageStats = async (
  db: LobeChatDatabase,
  input: GetSandboxPackageStatsInput,
): Promise<AdminSystemGetSandboxPackageStatsOutput> => {
  const days = input.days ?? 30;
  const limit = input.limit ?? 20;
  const table = platformSandboxPackageInstalls;
  const inWindow = sql`${table.lastAt} >= now() - (${days}::int * interval '1 day')`;
  const preinstalledSets = new Map<SandboxPackageInstallManager, ReadonlySet<string>>(
    Object.entries(SANDBOX_PREINSTALLED_BY_MANAGER).map(([manager, names]) => [
      manager as SandboxPackageInstallManager,
      new Set(names),
    ]),
  );

  const [items, [totalRow]] = await Promise.all([
    db
      .select({
        installs: sql<number>`coalesce(sum(${table.installCount}), 0)::int`.mapWith(Number),
        lastInstalledAt: max(table.lastAt),
        manager: table.manager,
        package: table.package,
        users: sql<number>`count(distinct ${table.userId})::int`.mapWith(Number),
      })
      .from(table)
      .where(inWindow)
      .groupBy(table.manager, table.package)
      .orderBy(sql`sum(${table.installCount}) DESC`, sql`count(distinct ${table.userId}) DESC`)
      .limit(limit),
    db
      .select({
        total: sql<number>`count(distinct (${table.manager}, ${table.package}))::int`.mapWith(
          Number,
        ),
      })
      .from(table)
      .where(inWindow),
  ]);

  const generatedAt = new Date();

  return {
    generatedAt,
    items: items.map((item) => {
      // Compare on the manager's own normal form (pip case/underscore folding, npm scopes and
      // version suffixes) against that manager's list, never across namespaces.
      const normalized = normalizeSandboxPackageName(item.package, item.manager) ?? item.package;
      return {
        installs: item.installs,
        lastInstalledAt: item.lastInstalledAt ?? generatedAt,
        manager: item.manager,
        package: item.package,
        preinstalled: preinstalledSets.get(item.manager)?.has(normalized) ?? false,
        users: item.users,
      };
    }),
    preinstalled: [...SANDBOX_PREINSTALLED_ALL],
    totalPackages: totalRow?.total ?? 0,
    windowDays: days,
  };
};
