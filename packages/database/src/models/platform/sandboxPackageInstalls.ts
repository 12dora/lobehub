import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  type NewPlatformSandboxPackageInstall,
  platformSandboxPackageInstalls,
  type SandboxPackageInstallManager,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

/** Truncate `last_command` after redaction. Credentials must not survive this cap. */
export const LAST_COMMAND_MAX = 300;

/** Distinct (user, manager, package) rows allowed per user. At the cap, only updates. */
export const PER_USER_PACKAGE_INSTALL_CAP = 500;

export interface SandboxPackageInstallUpsertRow {
  lastCommand: string;
  manager: SandboxPackageInstallManager;
  package: string;
  userId: string;
}

const truncateCommand = (command: string): string =>
  command.length > LAST_COMMAND_MAX ? command.slice(0, LAST_COMMAND_MAX) : command;

/**
 * Upserts per-user sandbox package-install rows.
 *
 * Deep-import this file from the runtime hot path — do not pull
 * `models/platform` (the barrel loads ~30 unrelated models).
 */
export class PlatformSandboxPackageInstallsModel {
  private readonly db: LobeChatDatabase | Transaction;

  constructor(db: LobeChatDatabase | Transaction) {
    this.db = db;
  }

  /**
   * One row per (user_id, manager, package). Conflict increments `install_count`
   * and refreshes `last_at` / `last_command`. Duplicate keys in `rows` are
   * collapsed first so a single INSERT cannot hit the same unique key twice.
   */
  upsert = async (rows: SandboxPackageInstallUpsertRow[]): Promise<number> => {
    if (rows.length === 0) return 0;

    const byKey = new Map<string, SandboxPackageInstallUpsertRow>();
    for (const row of rows) {
      if (!row.userId || !row.package) continue;
      byKey.set(`${row.userId}\0${row.manager}\0${row.package}`, row);
    }
    const uniqueRows = [...byKey.values()];
    if (uniqueRows.length === 0) return 0;

    const table = platformSandboxPackageInstalls;
    const accepted = await this.filterToCardinalityCap(table, uniqueRows);
    if (accepted.length === 0) return 0;

    const values: NewPlatformSandboxPackageInstall[] = accepted.map((row) => ({
      installCount: 1,
      lastCommand: truncateCommand(row.lastCommand),
      manager: row.manager,
      package: row.package,
      userId: row.userId,
    }));

    await this.db
      .insert(table)
      .values(values)
      .onConflictDoUpdate({
        set: {
          installCount: sql`${table.installCount} + 1`,
          lastAt: sql`now()`,
          lastCommand: sql`excluded.last_command`,
          updatedAt: sql`now()`,
        },
        target: [table.userId, table.manager, table.package],
      });

    return accepted.length;
  };

  /**
   * Enforce {@link PER_USER_PACKAGE_INSTALL_CAP}. One `count(*)` per distinct
   * user in the batch. When a user is already at the cap, only rows that
   * already exist are kept (updates); new packages are dropped.
   */
  private filterToCardinalityCap = async (
    table: typeof platformSandboxPackageInstalls,
    uniqueRows: SandboxPackageInstallUpsertRow[],
  ): Promise<SandboxPackageInstallUpsertRow[]> => {
    const userIds = [...new Set(uniqueRows.map((row) => row.userId))];
    const remainingByUser = new Map<string, number>();
    const existingKeys = new Set<string>();

    for (const userId of userIds) {
      const [countRow] = await this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.userId, userId));
      remainingByUser.set(
        userId,
        Math.max(0, PER_USER_PACKAGE_INSTALL_CAP - (countRow?.value ?? 0)),
      );

      const userPackages = [
        ...new Set(uniqueRows.filter((row) => row.userId === userId).map((row) => row.package)),
      ];
      if (userPackages.length === 0) continue;

      const existing = await this.db
        .select({ manager: table.manager, package: table.package })
        .from(table)
        .where(and(eq(table.userId, userId), inArray(table.package, userPackages)));
      for (const row of existing) {
        existingKeys.add(`${userId}\0${row.manager}\0${row.package}`);
      }
    }

    const accepted: SandboxPackageInstallUpsertRow[] = [];
    for (const row of uniqueRows) {
      const key = `${row.userId}\0${row.manager}\0${row.package}`;
      if (existingKeys.has(key)) {
        accepted.push(row);
        continue;
      }
      const remaining = remainingByUser.get(row.userId) ?? 0;
      if (remaining <= 0) continue;
      accepted.push(row);
      remainingByUser.set(row.userId, remaining - 1);
    }
    return accepted;
  };
}
