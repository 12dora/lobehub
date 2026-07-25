/**
 * Recent reauthentication guard for high-risk admin mutations (M04).
 * M13 may harden window policy / step-up flows; keep this boundary small.
 *
 * Trust only server-propagated auth metadata (session createdAt / OIDC iat).
 * Never read client timestamps or reauth headers.
 */
import { ADMIN_ERROR_CODES } from '@/const/platform/errorCodes';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { AuthMethod } from '@/libs/trpc/lambda/context';

import { ADMIN_REAUTH_MAX_AGE_MS } from '../contracts/adminUsers';
import type { AuditAction, AuditTargetType } from '../services/audit/auditActionCatalog';
import { PlatformAuditService } from '../services/platformAudit';
import { throwEnterpriseError } from './enterpriseErrors';

export interface ReauthContext {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
}

/**
 * Assert the principal has a recent interactive authentication signal.
 * API keys and missing/stale authenticatedAt → ADMIN_REAUTH_REQUIRED.
 */
export const assertRecentReauth = (
  ctx: ReauthContext,
  maxAgeMs: number = ADMIN_REAUTH_MAX_AGE_MS,
): void => {
  if (ctx.authMethod === 'api-key') {
    throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'api_key_not_interactive' },
      httpCode: 'UNAUTHORIZED',
    });
  }

  const at = ctx.authenticatedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'missing_authenticated_at' },
      httpCode: 'UNAUTHORIZED',
    });
  }

  const age = Date.now() - at.getTime();
  if (age < 0 || age > maxAgeMs) {
    return throwEnterpriseError({
      code: ADMIN_ERROR_CODES.ADMIN_REAUTH_REQUIRED,
      details: { reason: 'stale_authenticated_at' },
      httpCode: 'UNAUTHORIZED',
    });
  }
};

/**
 * Sanitized descriptor for the denied-audit row written when reauth fails.
 * Secrets must never appear in `reason`; use `resolveDeniedReason` for lazy
 * secret-safe evaluation only on the denial path.
 */
export interface DeniedAuditDescriptor {
  action: AuditAction;
  actorUserId: string;
  /** Optional beforeDiff on the denied audit row (e.g. managed-resources). */
  beforeDiff?: Record<string, unknown> | null;
  /**
   * Static reason for the denied audit row. Prefer this when the reason is
   * already secret-safe; use `resolveDeniedReason` when scanning secrets only
   * on the denial path.
   */
  reason?: string | null;
  requestId?: string | null;
  /**
   * Lazy reason resolver invoked only after reauth fails. Takes precedence
   * over `reason` when provided (including when it resolves to null).
   */
  resolveDeniedReason?: () => string | null | undefined | Promise<string | null | undefined>;
  targetId?: string | null;
  targetType: AuditTargetType;
}

export interface AssertDangerousReauthWithAuditParams {
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  denied: DeniedAuditDescriptor;
  maxAgeMs?: number;
  serverDB: LobeChatDatabase | Transaction;
}

/**
 * Shared dangerous-mutation reauth gate: assert recent interactive reauth, and
 * on failure append a best-effort `denied` audit row then rethrow.
 *
 * Audit-append failure observability is centralized (no per-router silence or
 * log-schema knobs). Call sites only supply the denial descriptor + auth signal.
 */
export const assertDangerousReauthWithAudit = async (
  params: AssertDangerousReauthWithAuditParams,
): Promise<void> => {
  try {
    assertRecentReauth(
      {
        authenticatedAt: params.authenticatedAt,
        authMethod: params.authMethod,
      },
      params.maxAgeMs,
    );
  } catch (error) {
    const denied = params.denied;
    try {
      const reason =
        denied.resolveDeniedReason === undefined
          ? (denied.reason ?? null)
          : ((await denied.resolveDeniedReason()) ?? null);

      await new PlatformAuditService(params.serverDB).append({
        action: denied.action,
        actorUserId: denied.actorUserId,
        afterDiff: { error: 'reauth_required' },
        ...(denied.beforeDiff !== undefined ? { beforeDiff: denied.beforeDiff } : {}),
        reason,
        ...(denied.requestId !== undefined ? { requestId: denied.requestId } : {}),
        result: 'denied',
        targetId: denied.targetId ?? null,
        targetType: denied.targetType,
      });
    } catch (auditError) {
      PlatformAuditService.logDeniedAuditAppendFailure(auditError, denied.action);
    }
    throw error;
  }
};
