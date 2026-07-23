import { ADMIN_PROCEDURE_AUTHORIZATION_AUDIT_CONNECTORS } from './entries.auditConnectors';
import { ADMIN_PROCEDURE_AUTHORIZATION_CATALOG } from './entries.catalog';
import { ADMIN_PROCEDURE_AUTHORIZATION_IDENTITY_ACCESS } from './entries.identityAccess';
import { ADMIN_PROCEDURE_AUTHORIZATION_PLATFORM } from './entries.platform';
import type { AdminProcedureAuthorization } from './types';

/**
 * Current authorization facts for every procedure exported by adminRouter.
 *
 * OIDC restart procedures retain their dedicated OIDC_PUBLISH gate. Platform diagnostics and
 * generic job controls use the narrower SYSTEM_READ / SYSTEM_OPERATE split.
 *
 * Entries are split by domain for maintainability; this array remains the single reconciliation source.
 * `as const satisfies` keeps per-entry literal shapes so `permission` narrows correctly for consumers.
 */
export const ADMIN_PROCEDURE_AUTHORIZATION_REGISTRY = [
  ...ADMIN_PROCEDURE_AUTHORIZATION_CATALOG,
  ...ADMIN_PROCEDURE_AUTHORIZATION_AUDIT_CONNECTORS,
  ...ADMIN_PROCEDURE_AUTHORIZATION_IDENTITY_ACCESS,
  ...ADMIN_PROCEDURE_AUTHORIZATION_PLATFORM,
] as const satisfies readonly AdminProcedureAuthorization[];
