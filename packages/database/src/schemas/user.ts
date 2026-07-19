import { DEFAULT_PREFERENCE } from '@lobechat/const';
import type { UserAgentOnboarding, UserOnboarding } from '@lobechat/types';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, varchar } from 'drizzle-orm/pg-core';

import { timestamps, timestamptz } from './_helpers';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey().notNull(),
    username: text('username').unique(),
    email: text('email').unique(),
    normalizedEmail: text('normalized_email').unique(),

    avatar: text('avatar'),
    phone: text('phone').unique(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    fullName: text('full_name'),
    interests: varchar('interests', { length: 64 }).array(),

    /** @deprecated */
    isOnboarded: boolean('is_onboarded').default(false),
    agentOnboarding: jsonb('agent_onboarding').$type<UserAgentOnboarding>(),
    onboarding: jsonb('onboarding').$type<UserOnboarding>(),
    // Time user was created in Clerk
    clerkCreatedAt: timestamptz('clerk_created_at'),

    // Required by better-auth
    emailVerified: boolean('email_verified').default(false).notNull(),
    // Required by nextauth, all null allowed
    emailVerifiedAt: timestamptz('email_verified_at'),

    preference: jsonb('preference').$defaultFn(() => DEFAULT_PREFERENCE),

    // better-auth admin
    role: text('role'),
    banned: boolean('banned').default(false),
    banReason: text('ban_reason'),
    banExpires: timestamptz('ban_expires'),

    /**
     * M04 security epoch: credentials (Better Auth session createdAt / OIDC iat /
     * API-key createdAt) issued at or before this timestamp are rejected after
     * ban / session revoke — unless the trusted Better Auth session id matches
     * `authInvalidatedExcludedSessionId`.
     */
    authInvalidatedAt: timestamptz('auth_invalidated_at'),
    /**
     * Optional single Better Auth session id exempt from the authInvalidatedAt
     * cutoff (includeCurrent=false revoke). Never a token. Cleared on ban /
     * full revoke. OIDC/API-key cannot use this exception.
     */
    authInvalidatedExcludedSessionId: text('auth_invalidated_excluded_session_id'),

    /** Stable DingTalk title copied from a trusted enterprise OIDC profile on first sign-in */
    dingtalkTitle: text('dingtalk_title'),
    /** Stable DingTalk subject copied from a trusted enterprise OIDC profile on first sign-in */
    dingtalkUserId: text('dingtalk_user_id'),

    // better-auth two-factor
    twoFactorEnabled: boolean('two_factor_enabled').default(false),

    // better-auth phone number
    phoneNumberVerified: boolean('phone_number_verified'),
    lastActiveAt: timestamptz('last_active_at').notNull().defaultNow(),

    ...timestamps,
  },
  (table) => [
    index('users_email_idx').on(table.email),
    index('users_username_idx').on(table.username),
    index('users_created_at_idx').on(table.createdAt),
    /**
     * Partial index to speed up admin queries on banned users.
     * Only rows with banned=true are indexed.
     */
    index('users_banned_true_created_at_idx')
      .on(table.createdAt)
      .where(sql`${table.banned} = true`),
    /**
     * M04 admin list prefix search: lower(field) text_pattern_ops for `LIKE 'prefix%'`.
     * Opclass is part of the expression so drizzle-kit serializes it into SQL + snapshot.
     */
    index('users_email_lower_pattern_idx').using(
      'btree',
      sql`lower(${table.email}) text_pattern_ops`,
    ),
    index('users_username_lower_pattern_idx').using(
      'btree',
      sql`lower(${table.username}) text_pattern_ops`,
    ),
    index('users_normalized_email_lower_pattern_idx').using(
      'btree',
      sql`lower(${table.normalizedEmail}) text_pattern_ops`,
    ),
  ],
);

export type NewUser = typeof users.$inferInsert;
export type UserItem = typeof users.$inferSelect;

export const userSettings = pgTable('user_settings', {
  id: text('id')
    .references(() => users.id, { onDelete: 'cascade' })
    .primaryKey(),

  tts: jsonb('tts'),
  hotkey: jsonb('hotkey'),
  keyVaults: text('key_vaults'),
  general: jsonb('general'),
  languageModel: jsonb('language_model'),
  systemAgent: jsonb('system_agent'),
  defaultAgent: jsonb('default_agent'),
  market: jsonb('market'),
  memory: jsonb('memory'),
  tool: jsonb('tool'),
  image: jsonb('image'),
  notification: jsonb('notification'),
});
export type UserSettingsItem = typeof userSettings.$inferSelect;
