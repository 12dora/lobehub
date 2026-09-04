// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LobeChatDatabase } from '@/database/type';

const mocks = vi.hoisted(() => ({
  bootstrapSuperAdmin: vi.fn(),
  ensureAgentTemplateCatalogSeeded: vi.fn(),
  ensureDefaultInboxProvisioned: vi.fn(),
  ensurePlatformRbacSeeded: vi.fn(),
  ensureTaskTemplateCatalogSeeded: vi.fn(),
  getServerDB: vi.fn(),
}));

vi.mock('./superAdmin', () => ({
  bootstrapSuperAdmin: mocks.bootstrapSuperAdmin,
  ensurePlatformRbacSeeded: mocks.ensurePlatformRbacSeeded,
}));

vi.mock('../services/templateCatalogBootstrap', () => ({
  ensureAgentTemplateCatalogSeeded: mocks.ensureAgentTemplateCatalogSeeded,
  ensureTaskTemplateCatalogSeeded: mocks.ensureTaskTemplateCatalogSeeded,
}));

vi.mock('../services/agentCatalog/adminService', () => ({
  DEFAULT_INBOX_BOOTSTRAP_ACTOR: null,
  ensureDefaultInboxProvisioned: mocks.ensureDefaultInboxProvisioned,
}));

vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: mocks.getServerDB,
}));

const {
  bootstrapPlatformAdminRuntime,
  resetPlatformBootstrapForTest,
  runStartupPlatformBootstrap,
} = await import('./startupBootstrap');

/** The module only forwards the handle to the mocked bootstrap helpers. */
const db = {} as LobeChatDatabase;

const baseEnv = {
  DATABASE_URL: 'postgresql://localhost:5432/test',
  ENABLE_PLATFORM_ADMIN: '1',
};

let infoSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPlatformBootstrapForTest();
  mocks.ensurePlatformRbacSeeded.mockResolvedValue({ superAdminCount: 0 });
  mocks.ensureAgentTemplateCatalogSeeded.mockResolvedValue(undefined);
  mocks.ensureDefaultInboxProvisioned.mockResolvedValue(undefined);
  mocks.ensureTaskTemplateCatalogSeeded.mockResolvedValue(undefined);
  mocks.getServerDB.mockResolvedValue(db);
  mocks.bootstrapSuperAdmin.mockReset();
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  mocks.ensurePlatformRbacSeeded.mockReset();
  mocks.ensureAgentTemplateCatalogSeeded.mockReset();
  mocks.ensureDefaultInboxProvisioned.mockReset();
  mocks.ensureTaskTemplateCatalogSeeded.mockReset();
  mocks.getServerDB.mockReset();
});

describe('runStartupPlatformBootstrap', () => {
  it('seeds platform RBAC and stops when no bootstrap selector is configured', async () => {
    mocks.ensurePlatformRbacSeeded.mockResolvedValue({ superAdminCount: 2 });

    const outcome = await runStartupPlatformBootstrap(db, baseEnv);

    expect(outcome).toEqual({ status: 'seeded', superAdminCount: 2 });
    expect(mocks.ensurePlatformRbacSeeded).toHaveBeenCalledWith(db);
    expect(mocks.ensureAgentTemplateCatalogSeeded).toHaveBeenCalledWith(db);
    expect(mocks.ensureTaskTemplateCatalogSeeded).toHaveBeenCalledWith(db);
    expect(mocks.ensureDefaultInboxProvisioned).not.toHaveBeenCalled();
    expect(mocks.bootstrapSuperAdmin).not.toHaveBeenCalled();
  });

  it('does not fail boot when template catalog seed throws', async () => {
    mocks.ensureAgentTemplateCatalogSeeded.mockRejectedValue(new Error('seed failed'));

    const outcome = await runStartupPlatformBootstrap(db, baseEnv);

    expect(outcome).toEqual({ status: 'seeded', superAdminCount: 0 });
    expect(errorSpy).toHaveBeenCalled();
    expect(mocks.bootstrapSuperAdmin).not.toHaveBeenCalled();
  });

  it('promotes an existing user by email and does not print a password', async () => {
    mocks.bootstrapSuperAdmin.mockResolvedValue({
      alreadySuperAdmin: false,
      createdUser: false,
      credentialRepaired: false,
      roleAssigned: true,
      userId: 'user-1',
    });

    const outcome = await runStartupPlatformBootstrap(db, {
      ...baseEnv,
      BOOTSTRAP_SUPER_ADMIN_EMAIL: '  admin@example.com  ',
    });

    expect(mocks.bootstrapSuperAdmin).toHaveBeenCalledWith(db, {
      allowCreate: false,
      email: 'admin@example.com',
      password: undefined,
      repairCredential: false,
      userId: null,
      username: undefined,
    });
    expect(outcome.status).toBe('bootstrapped');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalled();
  });

  it('forwards create/repair knobs and prints the generated password exactly once', async () => {
    mocks.bootstrapSuperAdmin.mockResolvedValue({
      alreadySuperAdmin: false,
      createdUser: true,
      credentialRepaired: false,
      oneTimePassword: 'generated-one-time-secret',
      roleAssigned: true,
      userId: 'breakglass_1',
    });

    await runStartupPlatformBootstrap(db, {
      ...baseEnv,
      BOOTSTRAP_ALLOW_CREATE: '1',
      BOOTSTRAP_REPAIR_CREDENTIAL: '1',
      BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
      BOOTSTRAP_SUPER_ADMIN_USERNAME: 'admin',
    });

    expect(mocks.bootstrapSuperAdmin).toHaveBeenCalledWith(db, {
      allowCreate: true,
      email: 'admin@example.com',
      password: undefined,
      repairCredential: true,
      userId: null,
      username: 'admin',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain('generated-one-time-secret');
  });

  it('is idempotent across restarts: an existing super admin prints no password', async () => {
    mocks.bootstrapSuperAdmin.mockResolvedValue({
      alreadySuperAdmin: true,
      createdUser: false,
      credentialRepaired: false,
      roleAssigned: false,
      userId: 'breakglass_1',
    });

    const outcome = await runStartupPlatformBootstrap(db, {
      ...baseEnv,
      BOOTSTRAP_ALLOW_CREATE: '1',
      BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
    });

    expect(outcome).toMatchObject({ status: 'bootstrapped' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never throws when the bootstrap fails (e.g. AUTH_DISABLE_EMAIL_PASSWORD)', async () => {
    mocks.bootstrapSuperAdmin.mockRejectedValue(
      new Error(
        'Cannot create break-glass credential while AUTH_DISABLE_EMAIL_PASSWORD is enabled',
      ),
    );

    const outcome = await runStartupPlatformBootstrap(db, {
      ...baseEnv,
      BOOTSTRAP_ALLOW_CREATE: '1',
      BOOTSTRAP_SUPER_ADMIN_EMAIL: 'admin@example.com',
    });

    expect(outcome).toEqual({ errorCategory: 'Error', status: 'failed' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('never throws when the RBAC seed itself fails', async () => {
    mocks.ensurePlatformRbacSeeded.mockRejectedValue(new Error('connection refused'));

    const outcome = await runStartupPlatformBootstrap(db, baseEnv);

    expect(outcome).toEqual({ errorCategory: 'Error', status: 'failed' });
  });
});

describe('bootstrapPlatformAdminRuntime', () => {
  it('does nothing when the platform admin flag and managed agents are both off', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({
      DATABASE_URL: 'postgresql://x',
      ENABLE_PLATFORM_ADMIN: '0',
      ENABLE_PLATFORM_MANAGED_AGENTS: '0',
    });

    expect(outcome).toEqual({ reason: 'platform-admin-disabled', status: 'skipped' });
    expect(mocks.getServerDB).not.toHaveBeenCalled();
    expect(mocks.ensurePlatformRbacSeeded).not.toHaveBeenCalled();
    expect(mocks.ensureAgentTemplateCatalogSeeded).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultInboxProvisioned).not.toHaveBeenCalled();
  });

  it('provisions the default inbox when admin is off and managed agents is on', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({
      DATABASE_URL: 'postgresql://x',
      DEFAULT_LANG: 'zh-CN',
      ENABLE_PLATFORM_ADMIN: '0',
      ENABLE_PLATFORM_MANAGED_AGENTS: '1',
    });

    expect(outcome).toEqual({ status: 'seeded', superAdminCount: 0 });
    expect(mocks.getServerDB).toHaveBeenCalled();
    expect(mocks.ensurePlatformRbacSeeded).not.toHaveBeenCalled();
    expect(mocks.ensureAgentTemplateCatalogSeeded).not.toHaveBeenCalled();
    expect(mocks.ensureTaskTemplateCatalogSeeded).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultInboxProvisioned).toHaveBeenCalledTimes(1);
    expect(mocks.ensureDefaultInboxProvisioned).toHaveBeenCalledWith(db, { locale: 'zh-CN' });
  });

  it('runs managed-agents provision after admin template seeding', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({
      ...baseEnv,
      ENABLE_PLATFORM_MANAGED_AGENTS: '1',
    });

    expect(outcome).toEqual({ status: 'seeded', superAdminCount: 0 });
    expect(mocks.ensureAgentTemplateCatalogSeeded).toHaveBeenCalledWith(db);
    expect(mocks.ensureAgentTemplateCatalogSeeded).toHaveBeenCalledBefore(
      mocks.ensureDefaultInboxProvisioned,
    );
    expect(mocks.ensureDefaultInboxProvisioned).toHaveBeenCalledTimes(1);
  });

  it('skips default-inbox provision when the managed-agents module is disabled', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({
      ...baseEnv,
      ENABLE_PLATFORM_MANAGED_AGENTS: '0',
    });

    expect(outcome).toEqual({ status: 'seeded', superAdminCount: 0 });
    expect(mocks.ensurePlatformRbacSeeded).toHaveBeenCalled();
    expect(mocks.ensureDefaultInboxProvisioned).not.toHaveBeenCalled();
  });

  it('accepts the ENABLE_ENTERPRISE_ADMIN alias but still needs a database URL', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({ ENABLE_ENTERPRISE_ADMIN: 'true' });

    expect(outcome).toEqual({ reason: 'no-database-url', status: 'skipped' });
    expect(mocks.ensurePlatformRbacSeeded).not.toHaveBeenCalled();
  });

  it('does nothing during the production build phase', async () => {
    const outcome = await bootstrapPlatformAdminRuntime({
      ...baseEnv,
      NEXT_PHASE: 'phase-production-build',
    });

    expect(outcome).toEqual({ reason: 'build-phase', status: 'skipped' });
    expect(mocks.ensurePlatformRbacSeeded).not.toHaveBeenCalled();
  });

  it('runs at most once per process', async () => {
    const first = await bootstrapPlatformAdminRuntime({
      DATABASE_URL: 'postgresql://x',
      ENABLE_PLATFORM_ADMIN: '0',
      ENABLE_PLATFORM_MANAGED_AGENTS: '0',
    });
    const second = await bootstrapPlatformAdminRuntime({ ...baseEnv });

    expect(second).toBe(first);
  });
});
