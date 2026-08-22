import { max, sql } from 'drizzle-orm';

import { platformSandboxPackageInstalls } from '@/database/schemas/platform';
import type { LobeChatDatabase } from '@/database/type';
import { normalizeSandboxPackageName } from '@/server/services/sandbox/packageLedger';
import { SANDBOX_PREINSTALLED_PIP_PACKAGES } from '@/server/services/sandbox/preinstalled';

import type { AdminSystemGetSandboxPackageStatsOutput } from '../../contracts/adminSystem';

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
  const preinstalledSet = new Set<string>(SANDBOX_PREINSTALLED_PIP_PACKAGES);

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
      const normalized =
        item.manager === 'pip'
          ? (normalizeSandboxPackageName(item.package, 'pip') ?? item.package)
          : item.package;
      return {
        installs: item.installs,
        lastInstalledAt: item.lastInstalledAt ?? generatedAt,
        manager: item.manager,
        package: item.package,
        preinstalled: item.manager === 'pip' && preinstalledSet.has(normalized),
        users: item.users,
      };
    }),
    preinstalled: [...SANDBOX_PREINSTALLED_PIP_PACKAGES],
    totalPackages: totalRow?.total ?? 0,
    windowDays: days,
  };
};
