import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

import { idGenerator } from '../../utils/idGenerator';
import { createdAt, timestamptz, updatedAt } from '../_helpers';
import { users } from '../user';

export type SandboxPackageInstallManager = 'apt' | 'npm' | 'pip';

/**
 * Per-user sandbox package-install ledger. One row per (user, manager, package);
 * `install_count` is a lifetime accumulator that is incremented on each observed
 * install command. `last_command` is a truncated copy of the matching install
 * invocation (not the whole script) for operator debugging.
 */
export const platformSandboxPackageInstalls = pgTable(
  'platform_sandbox_package_installs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('platformSandboxPackageInstalls', 16))
      .notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    manager: text('manager').$type<SandboxPackageInstallManager>().notNull(),
    /** Normalized package name (lowercase; pip `_`→`-`; extras/version stripped). */
    package: text('package').notNull(),
    installCount: integer('install_count').notNull().default(1),
    /** Raw install command (≤ 300 chars, secrets redacted); not the whole script. */
    lastCommand: text('last_command'),
    firstAt: timestamptz('first_at').notNull().defaultNow(),
    lastAt: timestamptz('last_at').notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('platform_sandbox_package_installs_user_manager_package_unique').on(
      t.userId,
      t.manager,
      t.package,
    ),
    index('platform_sandbox_package_installs_manager_package_last_at_idx').on(
      t.manager,
      t.package,
      t.lastAt,
    ),
    check(
      'platform_sandbox_package_installs_manager_check',
      sql`${t.manager} IN ('apt', 'npm', 'pip')`,
    ),
  ],
);

export type PlatformSandboxPackageInstallItem = typeof platformSandboxPackageInstalls.$inferSelect;
export type NewPlatformSandboxPackageInstall = typeof platformSandboxPackageInstalls.$inferInsert;
