export {
  type AdminAuthorizationReconciliationInput,
  reconcileAdminProcedureAuthorization,
  type TrpcProcedureDefinition,
} from './reconcile';
export { ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY } from './registry';
export type {
  AdminProcedureAuthorization,
  AdminProcedureKind,
  AdminProcedurePermissionAuthorization,
  AdminProcedureSelfAuthorization,
} from './types';
