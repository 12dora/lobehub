import type { PlatformPermission } from '@/const/platform/permissions';

import { getPlatformPermissionMetadata } from '../../../guards/platformPermission';
import { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from './registry';
import type { AdminProcedureAuthorization } from './types';

export interface TrpcProcedureDefinition {
  _def?: {
    type?: unknown;
  };
}

export interface AdminAuthorizationReconciliationInput {
  adminProcedures: Readonly<Record<string, TrpcProcedureDefinition>>;
  lambdaProcedures: Readonly<Record<string, TrpcProcedureDefinition>>;
  mutationPaths: readonly `admin.${string}`[];
  registry?: readonly AdminProcedureAuthorization[];
}

const samePermissions = (
  actual: readonly PlatformPermission[] | undefined,
  expected: readonly PlatformPermission[] | undefined,
): boolean => {
  const left = actual ?? [];
  const right = expected ?? [];
  return (
    left.length === right.length && left.every((permission, index) => permission === right[index])
  );
};

/**
 * Reconcile static declarations with live tRPC objects. This never invokes a resolver.
 */
export const reconcileAdminProcedureAuthorization = ({
  adminProcedures,
  lambdaProcedures,
  mutationPaths,
  registry = ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
}: AdminAuthorizationReconciliationInput): void => {
  const failures: string[] = [];
  const declarations = new Map<string, AdminProcedureAuthorization>();

  for (const declaration of registry) {
    if (declarations.has(declaration.path))
      failures.push(`duplicate registry path: ${declaration.path}`);
    declarations.set(declaration.path, declaration);
  }

  const actualPaths = new Set(Object.keys(adminProcedures).map((path) => `admin.${path}`));
  for (const path of actualPaths) {
    if (!declarations.has(path)) failures.push(`missing registry path: ${path}`);
  }
  for (const path of declarations.keys()) {
    if (!actualPaths.has(path)) failures.push(`stale registry path: ${path}`);
  }

  const mountedAdminEntries = Object.entries(lambdaProcedures).filter(([path]) =>
    path.startsWith('admin.'),
  );
  for (const [relativePath, procedure] of Object.entries(adminProcedures)) {
    const expectedPath = `admin.${relativePath}`;
    const identityMounts = mountedAdminEntries.filter(([, mounted]) => mounted === procedure);
    if (identityMounts.length !== 1 || identityMounts[0]?.[0] !== expectedPath) {
      failures.push(`invalid lambda mount: ${expectedPath}`);
    }

    const declaration = declarations.get(expectedPath);
    if (!declaration) continue;

    if (procedure._def?.type !== declaration.kind) {
      failures.push(`kind mismatch: ${expectedPath}`);
    }

    const permissionMetadata = getPlatformPermissionMetadata(procedure);
    if ('selfAccess' in declaration) {
      if (permissionMetadata.length !== 0)
        failures.push(`self-access has permission gate: ${expectedPath}`);
      continue;
    }

    if (permissionMetadata.length !== 1) {
      failures.push(`expected exactly one permission gate: ${expectedPath}`);
      continue;
    }
    const [actual] = permissionMetadata;
    if (
      actual.mode !== declaration.permission.mode ||
      !samePermissions(actual.permissions, declaration.permission.permissions) ||
      !samePermissions(actual.selectable, declaration.permission.selectable)
    ) {
      failures.push(`permission mismatch: ${expectedPath}`);
    }
  }

  for (const [mountedPath] of mountedAdminEntries) {
    if (!actualPaths.has(mountedPath))
      failures.push(`unexpected lambda admin mount: ${mountedPath}`);
  }

  const actualMutations = new Set<`admin.${string}`>(
    Object.entries(adminProcedures)
      .filter(([, procedure]) => procedure._def?.type === 'mutation')
      .map(([path]) => `admin.${path}` as const),
  );
  const registeredMutations = new Set(mutationPaths);
  for (const path of actualMutations) {
    if (!registeredMutations.has(path)) failures.push(`missing mutation risk entry: ${path}`);
  }
  for (const path of registeredMutations) {
    if (!actualMutations.has(path)) failures.push(`stale mutation risk entry: ${path}`);
  }

  if (failures.length > 0) throw new Error(failures.join('\n'));
};

export const isAuthorizedByPlatformPermissions = (
  authorization: AdminProcedureAuthorization,
  permissions: ReadonlySet<PlatformPermission>,
): boolean => {
  if ('selfAccess' in authorization) return true;
  const { mode, permissions: required, selectable } = authorization.permission;
  if (mode === 'all') {
    return required.every((permission) => permissions.has(permission));
  }
  if (mode === 'any') {
    return required.some((permission) => permissions.has(permission));
  }
  // compound: fixed permissions + at least one selectable secondary permission
  // (enough to invoke some input variant of the procedure).
  return (
    required.every((permission) => permissions.has(permission)) &&
    (selectable ?? []).some((permission) => permissions.has(permission))
  );
};
