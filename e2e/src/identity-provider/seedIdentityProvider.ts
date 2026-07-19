import { createHash } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';
import { checksumPayload } from '@/database/models/platform';
import * as schema from '@/database/schemas';
import {
  account,
  platformIdentityProviders,
  platformIdentityProviderSecrets,
  platformResourceRevisions,
  users,
} from '@/database/schemas';
import { assignGlobalPlatformRole, seedPlatformRoles } from '@/database/utils/seedPlatformRoles';
import { PlatformSecretService } from '@/server/enterprise/security/secret';
import {
  parsePublishedIdentityProviderPayload,
  type PublishedIdentityProviderPayload,
} from '@/server/enterprise/services/identityProvider/publicationService';

import { AUTHENTIK_FIXTURE_CLIENT_ID, AUTHENTIK_FIXTURE_ISSUER } from './authentikFixture';

export const IDENTITY_PROVIDER_KEY = 'work-account';
export const IDENTITY_PROVIDER_ID = 'plidp_e2e_authentik';
export const IDENTITY_PROVIDER_PUBLISHED_AT = new Date('2026-01-01T00:00:00.000Z');
export const E2E_ADMIN = {
  email: 'identity-admin-e2e@example.test',
  id: 'user_identity_admin_e2e',
  name: 'Identity Admin E2E',
  password: 'IdentityAdminE2E!123',
} as const;

interface SeedOptions {
  clientSecret: string;
  databaseUrl: string;
  masterKey: string;
}

export interface SeededIdentityProvider {
  admin: typeof E2E_ADMIN;
  payload: PublishedIdentityProviderPayload & { secretUpdatedAt: string };
  providerId: string;
}

const fingerprint = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

export const seedPublishedIdentityProvider = async (
  options: SeedOptions,
): Promise<SeededIdentityProvider> => {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    const now = new Date();
    const publishedAt = IDENTITY_PROVIDER_PUBLISHED_AT;
    const password = await bcrypt.hash(E2E_ADMIN.password, 10);
    await db
      .insert(users)
      .values({
        email: E2E_ADMIN.email,
        emailVerified: true,
        fullName: E2E_ADMIN.name,
        id: E2E_ADMIN.id,
        normalizedEmail: E2E_ADMIN.email,
        onboarding: { finishedAt: now.toISOString(), version: 1 },
      })
      .onConflictDoUpdate({
        set: { emailVerified: true, fullName: E2E_ADMIN.name, updatedAt: now },
        target: users.id,
      });
    await db
      .insert(account)
      .values({
        accountId: E2E_ADMIN.email,
        id: 'account_identity_admin_e2e',
        password,
        providerId: 'credential',
        userId: E2E_ADMIN.id,
      })
      .onConflictDoUpdate({
        set: { password, updatedAt: now },
        target: account.id,
      });
    await seedPlatformRoles(db);
    await assignGlobalPlatformRole(db, {
      roleName: PLATFORM_SYSTEM_ROLES.SUPER_ADMIN,
      userId: E2E_ADMIN.id,
    });

    const secrets = PlatformSecretService.tryFromEnv({
      PLATFORM_MASTER_KEY: options.masterKey,
      PLATFORM_MASTER_KEY_ID: 'identity-provider-e2e-key',
    });
    if (!secrets) throw new Error('platform secret service unavailable');
    const ciphertext = await secrets.encrypt(options.clientSecret);
    const secretFingerprint = fingerprint(options.clientSecret);
    const secretUpdatedAt = publishedAt.toISOString();
    const candidate = {
      autoProvision: true,
      buttonLabel: '使用工作账号登录',
      claimMapping: {
        dingtalkTitle: ['dingtalk_title'],
        dingtalkUserId: ['dingtalk_user_id'],
        email: ['email'],
        name: ['name', 'preferred_username'],
        picture: ['picture'],
        subject: ['sub'],
      },
      clientId: AUTHENTIK_FIXTURE_CLIENT_ID,
      displayName: 'Authentik Work Account',
      domainAllowlist: ['example.test'],
      enabled: true,
      groupRoleMapping: {},
      icon: null,
      issuer: AUTHENTIK_FIXTURE_ISSUER,
      providerKey: IDENTITY_PROVIDER_KEY,
      scopes: ['openid', 'profile', 'email', 'dingtalk'],
      secretFingerprint,
      secretUpdatedAt,
      type: 'authentik',
      usePkce: true,
    };
    const parsed = parsePublishedIdentityProviderPayload(candidate);
    if (!parsed?.secretUpdatedAt) throw new Error('published fixture payload rejected');
    const payload = { ...parsed, secretUpdatedAt: parsed.secretUpdatedAt };
    const secretRef = `kms://platform-identity-providers/${IDENTITY_PROVIDER_ID}/${secretFingerprint}`;

    await db.transaction(async (tx) => {
      await tx
        .insert(platformIdentityProviders)
        .values({
          activationRevision: 1,
          autoProvision: payload.autoProvision,
          buttonLabel: payload.buttonLabel,
          claimMapping: payload.claimMapping,
          clientId: payload.clientId,
          createdBy: E2E_ADMIN.id,
          displayName: payload.displayName,
          domainAllowlist: payload.domainAllowlist,
          enabled: true,
          groupRoleMapping: payload.groupRoleMapping,
          icon: payload.icon,
          id: IDENTITY_PROVIDER_ID,
          issuer: payload.issuer,
          providerKey: payload.providerKey,
          revision: 1,
          scopes: payload.scopes,
          secretFingerprint,
          secretRef,
          secretUpdatedAt: publishedAt,
          status: 'pending_restart',
          type: payload.type,
          updatedBy: E2E_ADMIN.id,
          usePkce: true,
        })
        .onConflictDoUpdate({
          set: {
            activationRevision: 1,
            enabled: true,
            revision: 1,
            secretFingerprint,
            secretRef,
            secretUpdatedAt: publishedAt,
            status: 'pending_restart',
            updatedAt: now,
          },
          target: platformIdentityProviders.id,
        });
      await tx
        .insert(platformIdentityProviderSecrets)
        .values({
          ciphertext,
          createdAt: publishedAt,
          fingerprint: secretFingerprint,
          id: 'plidps_e2e_authentik_v1',
          keyId: secrets.peekKeyId(ciphertext),
          providerId: IDENTITY_PROVIDER_ID,
          ref: secretRef,
          revision: 1,
        })
        .onConflictDoNothing();
      await tx
        .insert(platformResourceRevisions)
        .values({
          checksum: checksumPayload(payload),
          createdAt: publishedAt,
          createdBy: E2E_ADMIN.id,
          id: 'plrev_e2e_authentik_v1',
          payload,
          publishedAt,
          publishedBy: E2E_ADMIN.id,
          resourceId: IDENTITY_PROVIDER_ID,
          resourceType: 'oidc',
          revision: 1,
          secretFingerprint,
          status: 'published',
        })
        .onConflictDoNothing();
    });
    return { admin: E2E_ADMIN, payload, providerId: IDENTITY_PROVIDER_ID };
  } finally {
    await pool.end();
  }
};

export const cleanupPublishedIdentityProvider = async (databaseUrl: string): Promise<void> => {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  try {
    await db
      .delete(platformResourceRevisions)
      .where(
        and(
          eq(platformResourceRevisions.resourceType, 'oidc'),
          eq(platformResourceRevisions.resourceId, IDENTITY_PROVIDER_ID),
        ),
      );
    await db
      .delete(platformIdentityProviderSecrets)
      .where(eq(platformIdentityProviderSecrets.providerId, IDENTITY_PROVIDER_ID));
    await db
      .delete(platformIdentityProviders)
      .where(eq(platformIdentityProviders.id, IDENTITY_PROVIDER_ID));
    await db.delete(users).where(eq(users.id, E2E_ADMIN.id));
  } finally {
    await pool.end();
  }
};
