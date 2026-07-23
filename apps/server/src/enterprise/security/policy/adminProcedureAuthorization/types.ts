import type { PlatformPermissionMetadata } from '../../../guards/platformPermission';

export type AdminProcedureKind = 'mutation' | 'query';

export interface AdminProcedurePermissionAuthorization {
  kind: AdminProcedureKind;
  path: `admin.${string}`;
  permission: PlatformPermissionMetadata;
  selfAccess?: never;
}

export interface AdminProcedureSelfAuthorization {
  kind: 'query';
  path: 'admin.auth.getMyAccess';
  permission?: never;
  selfAccess: true;
}

export type AdminProcedureAuthorization =
  AdminProcedurePermissionAuthorization | AdminProcedureSelfAuthorization;
