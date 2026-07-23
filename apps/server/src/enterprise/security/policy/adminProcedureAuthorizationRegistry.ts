/**
 * Admin procedure authorization registry.
 * Implementation is split under `./adminProcedureAuthorization/` for maintainability.
 */
export type {
  AdminProcedureAuthorization,
  AdminProcedureKind,
  AdminProcedurePermissionAuthorization,
  AdminProcedureSelfAuthorization,
  TrpcProcedureDefinition,
} from './adminProcedureAuthorization';
export {
  ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY,
  type AdminAuthorizationReconciliationInput,
  isAuthorizedByPlatformPermissions,
  reconcileAdminProcedureAuthorization,
} from './adminProcedureAuthorization';
