import { sql } from 'drizzle-orm';

import {
  type NewPlatformSandboxPackageInstall,
  platformSandboxPackageInstalls,
  type SandboxPackageInstallManager,
} from '../../schemas/platform';
import type { LobeChatDatabase, Transaction } from '../../type';

const LAST_COMMAND_MAX = 500;

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
    const values: NewPlatformSandboxPackageInstall[] = uniqueRows.map((row) => ({
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

    return uniqueRows.length;
  };
}
