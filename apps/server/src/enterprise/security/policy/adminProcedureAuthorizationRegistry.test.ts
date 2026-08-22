// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { PLATFORM_PERMISSIONS, type PlatformPermission } from '@/const/platform/permissions';
import { authedProcedure } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { lambdaRouter } from '@/server/routers/lambda';

import { withActiveUser } from '../../guards/activeUser';
import {
  getAdminMutationRateLimitMetadata,
  withAdminMutationRateLimit,
} from '../../guards/adminMutationRateLimit';
import {
  getPlatformPermissionMetadata,
  withPlatformPermission,
} from '../../guards/platformPermission';
import { adminRouter } from '../../routers/admin';
import { ADMIN_MUTATION_REGISTRY } from './adminMutationRegistry';
import {
  ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
  type AdminProcedureAuthorization,
  reconcileAdminProcedureAuthorization,
  type TrpcProcedureDefinition,
} from './adminProcedureAuthorizationRegistry';

const mutationPaths = Object.keys(ADMIN_MUTATION_REGISTRY) as `admin.${string}`[];
type ProcedureUnderTest = TrpcProcedureDefinition & {
  _def: {
    middlewares: readonly unknown[];
    type?: unknown;
  };
};
type ProcedureRecord = Record<string, TrpcProcedureDefinition>;

const adminProcedures = adminRouter._def.procedures as unknown as ProcedureRecord;
const lambdaProcedures = lambdaRouter._def.procedures as unknown as ProcedureRecord;

const reconcile = (
  overrides: {
    adminProcedures?: typeof adminProcedures;
    lambdaProcedures?: typeof lambdaProcedures;
    mutationPaths?: readonly `admin.${string}`[];
    registry?: readonly AdminProcedureAuthorization[];
  } = {},
) =>
  reconcileAdminProcedureAuthorization({
    adminProcedures: overrides.adminProcedures ?? adminProcedures,
    lambdaProcedures: overrides.lambdaProcedures ?? lambdaProcedures,
    mutationPaths: overrides.mutationPaths ?? mutationPaths,
    registry: overrides.registry,
  });

const permissionProbe = (permission: PlatformPermission = PLATFORM_PERMISSIONS.AUDIT_READ) =>
  authedProcedure
    .use(serverDatabase)
    .use(withActiveUser())
    .use(withPlatformPermission(permission))
    .query(() => null);

describe('admin procedure authorization registry', () => {
  it('reconciles all live procedures, middleware gates, root mounts, and mutation risks', () => {
    expect(() => reconcile()).not.toThrow();

    // Registry length after the AI provider draft/publish surface collapsed into
    // applyImmediate and archive gave way to a true hard delete: 14 procedures removed
    // (10 mutations + 4 queries). The read-only aiProviders.listRevisions history query
    // stays — agent dependency pinning reads the published revision checksum from it.
    // +1 mutation since: admin.aiProviderOAuth.disconnect (withdraw the shared account).
    // −6/+2 mutations since: 统一管理 de-draft replaced
    // admin.settings.{saveDraft,validateDraft,publish,rollback} with admin.settings.save and
    // admin.managedResources.{saveDraft,publish} with admin.managedResources.save.
    // −3/+1 mutations since: 平台助理 de-draft replaced
    // admin.agents.{updateDraft,appendVersion,publish} with admin.agents.save.
    // +1 query since: admin.stats.rankUsers (用户排行 on the admin overview / statistics pages).
    // +1 query since: admin.stats.activitySeries (range-aware 活跃度 chart).
    // −3/+1 mutations since: 品牌自定义 de-draft replaced
    // admin.branding.{saveDraft,publish,rollback} with admin.branding.save, and
    // admin.branding.getDraft became admin.branding.get.
    // +1 query / +5 mutations since: 任务模板 (admin.taskTemplates.{list,create,update,
    // setEnabled,delete,importRecommendations}), reusing the platform-agent permission codes.
    // +1 mutation since: admin.taskTemplates.reorder (drag-and-drop display order replaced the
    // numeric sort field in the editor).
    // +1 query / +6 mutations since: 助理模板 (admin.agentTemplates.{list,create,update,
    // setEnabled,delete,importBuiltins,reorder}), reusing the platform-agent permission codes
    // and the taskTemplates module id.
    // +5 queries / +5 mutations since: content moderation (admin.contentModeration.{getSettings,
    // getOverview, getStats, listRecords, getRecord, updateSettings, testClassifier,
    // revealRecordPrompt, deleteRecords, clearDecisionCache}).
    // +6 queries / +11 mutations since: network proxy (admin.networkProxy.{getSettings,
    // getStatus, listSubscriptions, listNodes, getEngineLogs, getArtifactStatus,
    // updateSettings, updateScopes, createSubscription, updateSubscription,
    // deleteSubscription, refreshSubscription, testLatency, selectNode, installArtifact,
    // restartEngine, testConnectivity}).
    // +1 mutation since: admin.networkProxy.installGeodata (one-click geoip+geosite).
    // +3 since: admin.modules.{get,update,requestRestart} (deployment module switches).
    // +1 query / +1 mutation since: installation-wide browser profile read and regeneration.
    // +1 mutation since: admin.aiModels.syncUpstream (pull the catalog from the upstream account).
    // +1 query / +1 mutation since: admin.browserProfile.{options,update} (a chosen fingerprint).
    // +2 mutations since: admin.users.{setPassword,disableTwoFactor} (admin credential takeover).
    // +1 query / +1 mutation since: admin.system.{getSandboxSettings,updateSandboxSettings}
    // (local sandbox general-settings card).
    // +2 queries / +3 mutations since: admin.system.{getDocumentRenderSettings,
    // getDocumentRenderStatus, updateDocumentRenderSettings, retryDocumentRenderJob,
    // cancelDocumentRenderJob} (Gotenberg document-render settings, status, and queue).
    expect(ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY).toHaveLength(240);
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(({ kind }) => kind === 'query'),
    ).toHaveLength(108);
    expect(
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(({ kind }) => kind === 'mutation'),
    ).toHaveLength(132);
    expect(mutationPaths).toHaveLength(132);
    expect(ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter((entry) => 'selfAccess' in entry)).toEqual(
      [{ kind: 'query', path: 'admin.auth.getMyAccess', selfAccess: true }],
    );
  });

  it('keeps metadata private, immutable, and attached to the final middleware chain', () => {
    const procedure = adminProcedures['audit.get'] as ProcedureUnderTest;
    const metadata = getPlatformPermissionMetadata(procedure);
    const permissionMiddleware = procedure._def.middlewares.find((middleware: unknown) => {
      const carrier = Object.assign(() => undefined, { _def: { middlewares: [middleware] } });
      return getPlatformPermissionMetadata(carrier).length === 1;
    });

    expect(metadata).toEqual([{ mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] }]);
    const [metadataSymbol] = Object.getOwnPropertySymbols(permissionMiddleware!);
    expect(Object.keys(permissionMiddleware!)).toEqual([]);
    expect(
      Object.getOwnPropertyDescriptor(permissionMiddleware!, metadataSymbol!)?.enumerable,
    ).toBe(false);
    expect(JSON.stringify({ middleware: permissionMiddleware })).toBe('{}');
    expect(Object.isFrozen(metadata[0])).toBe(true);
    expect(Object.isFrozen(metadata[0]!.permissions)).toBe(true);
  });

  it('fails when a live procedure is added without a declaration', () => {
    const future = permissionProbe();
    expect(() =>
      reconcile({
        adminProcedures: { ...adminProcedures, future },
        lambdaProcedures: { ...lambdaProcedures, 'admin.future': future },
      }),
    ).toThrow('missing registry path: admin.future');
  });

  it('fails on removed, remounted, and duplicate lambda mounts by object identity', () => {
    const removed = { ...lambdaProcedures };
    delete removed['admin.audit.get'];

    const remounted = { ...lambdaProcedures };
    remounted['admin.audit.alias'] = remounted['admin.audit.get']!;
    delete remounted['admin.audit.get'];

    const duplicated = {
      ...lambdaProcedures,
      'admin.audit.alias': lambdaProcedures['admin.audit.get']!,
    };

    expect(() => reconcile({ lambdaProcedures: removed })).toThrow(
      'invalid lambda mount: admin.audit.get',
    );
    expect(() => reconcile({ lambdaProcedures: remounted })).toThrow(
      'invalid lambda mount: admin.audit.get',
    );
    expect(() => reconcile({ lambdaProcedures: duplicated })).toThrow(
      'invalid lambda mount: admin.audit.get',
    );
  });

  it('fails on duplicate, stale, kind-changed, and permission-changed declarations', () => {
    const duplicate = [
      ...ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
      ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY[0],
    ];
    const stale = [
      ...ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
      {
        kind: 'query',
        path: 'admin.future',
        permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_READ] },
      },
    ] as const satisfies readonly AdminProcedureAuthorization[];
    const kindChanged = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.map((declaration) =>
      declaration.path === 'admin.audit.get'
        ? { ...declaration, kind: 'mutation' as const }
        : declaration,
    );

    expect(() => reconcile({ registry: duplicate })).toThrow(
      'duplicate registry path: admin.agents.archive',
    );
    expect(() => reconcile({ registry: stale })).toThrow('stale registry path: admin.future');
    expect(() => reconcile({ registry: kindChanged })).toThrow('kind mismatch: admin.audit.get');

    const changedPermission = permissionProbe(PLATFORM_PERMISSIONS.USER_READ);
    expect(() =>
      reconcile({
        adminProcedures: { ...adminProcedures, 'audit.get': changedPermission },
        lambdaProcedures: { ...lambdaProcedures, 'admin.audit.get': changedPermission },
      }),
    ).toThrow('permission mismatch: admin.audit.get');
  });

  it('fails when a procedure has zero or multiple permission gates', () => {
    const missingGate = authedProcedure
      .use(serverDatabase)
      .use(withActiveUser())
      .query(() => null);
    const duplicateGate = authedProcedure
      .use(serverDatabase)
      .use(withActiveUser())
      .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
      .use(withPlatformPermission(PLATFORM_PERMISSIONS.USER_READ))
      .query(() => null);

    for (const replacement of [missingGate, duplicateGate]) {
      expect(() =>
        reconcile({
          adminProcedures: { ...adminProcedures, 'audit.get': replacement },
          lambdaProcedures: { ...lambdaProcedures, 'admin.audit.get': replacement },
        }),
      ).toThrow('expected exactly one permission gate: admin.audit.get');
    }
  });

  it('fails when the mutation risk registry is missing or stale', () => {
    expect(() => reconcile({ mutationPaths: mutationPaths.slice(1) })).toThrow(
      'missing mutation risk entry',
    );
    expect(() => reconcile({ mutationPaths: [...mutationPaths, 'admin.future'] })).toThrow(
      'stale mutation risk entry: admin.future',
    );
  });

  it('records the OIDC and system-operation permissions independently', () => {
    const systemEntries = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(({ path }) =>
      path.startsWith('admin.system.'),
    );
    expect(systemEntries).toHaveLength(18);
    expect(
      systemEntries.map((entry) =>
        'permission' in entry ? [entry.path, entry.permission.permissions[0]] : [entry.path, null],
      ),
    ).toEqual([
      ['admin.system.cancelDocumentRenderJob', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.cancelJob', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.getAuthSnapshotStatus', PLATFORM_PERMISSIONS.OIDC_PUBLISH],
      ['admin.system.getDocumentRenderSettings', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getDocumentRenderStatus', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getInfraSettings', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getInstanceRevisions', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getJobs', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getSandboxSettings', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.getStatus', PLATFORM_PERMISSIONS.SYSTEM_READ],
      ['admin.system.prepareRestart', PLATFORM_PERMISSIONS.OIDC_PUBLISH],
      ['admin.system.requestRestart', PLATFORM_PERMISSIONS.OIDC_PUBLISH],
      ['admin.system.retryDocumentRenderJob', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.retryJob', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.testDependency', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.updateDocumentRenderSettings', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.updateInfraSettings', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
      ['admin.system.updateSandboxSettings', PLATFORM_PERMISSIONS.SYSTEM_OPERATE],
    ]);
    // A3: exactly five admin.audit.exports.* procedures, all gated by AUDIT_EXPORT.
    const auditExportEntries = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(
      (entry) => 'path' in entry && entry.path.startsWith('admin.audit.exports.'),
    );
    expect(auditExportEntries.map((entry) => entry.path).sort()).toEqual([
      'admin.audit.exports.cancel',
      'admin.audit.exports.create',
      'admin.audit.exports.download',
      'admin.audit.exports.get',
      'admin.audit.exports.list',
    ]);
    for (const entry of auditExportEntries) {
      expect(entry).toMatchObject({
        permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_EXPORT] },
      });
    }
    // No other procedures should claim AUDIT_EXPORT outside the export surface.
    const auditExportElsewhere = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(
      (entry) =>
        'permission' in entry &&
        !entry.path.startsWith('admin.audit.exports.') &&
        (entry.permission.permissions as readonly PlatformPermission[]).includes(
          PLATFORM_PERMISSIONS.AUDIT_EXPORT,
        ),
    );
    expect(auditExportElsewhere).toEqual([]);

    // A3 retention: six admin.audit.retention.* procedures, all gated by AUDIT_RETENTION_OPERATE.
    const auditRetentionEntries = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(
      (entry) => 'path' in entry && entry.path.startsWith('admin.audit.retention.'),
    );
    expect(auditRetentionEntries.map((entry) => entry.path).sort()).toEqual([
      'admin.audit.retention.cancel',
      'admin.audit.retention.dryRun',
      'admin.audit.retention.getRun',
      'admin.audit.retention.listRuns',
      'admin.audit.retention.run',
      'admin.audit.retention.status',
    ]);
    for (const entry of auditRetentionEntries) {
      expect(entry).toMatchObject({
        permission: { mode: 'all', permissions: [PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE] },
      });
    }
    const auditRetentionElsewhere = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY.filter(
      (entry) =>
        'permission' in entry &&
        !entry.path.startsWith('admin.audit.retention.') &&
        (entry.permission.permissions as readonly PlatformPermission[]).includes(
          PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE,
        ),
    );
    expect(auditRetentionElsewhere).toEqual([]);

    const dangerousReauthGaps = Object.values(ADMIN_MUTATION_REGISTRY).filter(
      (entry) => entry.dangerous && entry.controls.reauth.status === 'gap',
    );
    expect(dangerousReauthGaps.map(({ procedure }) => procedure).sort()).toEqual([]);
    const regularReauthGaps = Object.values(ADMIN_MUTATION_REGISTRY).filter(
      (entry) => !entry.dangerous && entry.controls.reauth.status === 'gap',
    );
    expect(regularReauthGaps.map(({ procedure }) => procedure).sort()).toEqual([]);
  });

  it('attaches private rate-limit middleware metadata to all live mutations', () => {
    const missing: string[] = [];
    for (const path of mutationPaths) {
      const relative = path.slice('admin.'.length);
      const procedure = adminProcedures[relative] as ProcedureUnderTest | undefined;
      const metadata = getAdminMutationRateLimitMetadata(procedure);
      if (metadata.length !== 1 || metadata[0]?.kind !== 'admin-mutation-rate-limit') {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);

    const sample = adminProcedures['aiProviders.test'] as ProcedureUnderTest;
    const rateMiddleware = sample._def.middlewares.find((middleware: unknown) => {
      const carrier = Object.assign(() => undefined, { _def: { middlewares: [middleware] } });
      return getAdminMutationRateLimitMetadata(carrier).length === 1;
    });
    expect(rateMiddleware).toBeTypeOf('function');
    const [metadataSymbol] = Object.getOwnPropertySymbols(rateMiddleware!);
    expect(Object.getOwnPropertyDescriptor(rateMiddleware!, metadataSymbol!)?.enumerable).toBe(
      false,
    );
    expect(JSON.stringify({ middleware: rateMiddleware })).toBe('{}');

    // Queries may share a base that hosts the type-gated middleware; mutations must have it.
    const query = adminProcedures['auth.getMyAccess'] as ProcedureUnderTest;
    expect(query._def.type).toBe('query');
  });

  it('does not invent rate-limit coverage without the middleware helper', () => {
    const bare = authedProcedure
      .use(serverDatabase)
      .use(withActiveUser())
      .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
      .mutation(() => null);
    expect(getAdminMutationRateLimitMetadata(bare)).toEqual([]);
    const withLimit = authedProcedure
      .use(serverDatabase)
      .use(withActiveUser())
      .use(withAdminMutationRateLimit())
      .use(withPlatformPermission(PLATFORM_PERMISSIONS.AUDIT_READ))
      .mutation(() => null);
    expect(getAdminMutationRateLimitMetadata(withLimit)).toEqual([
      { enforced: true, kind: 'admin-mutation-rate-limit' },
    ]);
  });
});
