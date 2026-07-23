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

export interface AssertDangerousReauthWithAuditParams {
  action: string;
  actorUserId: string;
  /**
   * When the denied-audit write fails:
   * - `false`: stay silent (legacy branding empty-catch / agents debug-only path)
   * - `string`: exact first argument to `console.error` (preserve per-site wording)
   * - omitted: `'[admin.reauth] reauth denied audit failed'`
   */
  auditFailureLog?: string | false;
  /**
   * Structured metadata merged into the `console.error` second arg (with
   * `errorClass`). Defaults to `{ action }` so sites that historically logged
   * action keep it; pass `{}` for errorClass-only sites.
   * Ignored when `auditFailureLog === false`.
   */
  auditFailureMeta?: Record<string, unknown>;
  authenticatedAt?: Date | null;
  authMethod?: AuthMethod | null;
  /** Optional beforeDiff on the denied audit row (e.g. managed-resources). */
  beforeDiff?: Record<string, unknown> | null;
  maxAgeMs?: number;
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
  serverDB: LobeChatDatabase | Transaction;
  targetId?: string | null;
  targetType: string;
}

/**
 * Shared dangerous-mutation reauth gate: assert recent interactive reauth, and
 * on failure append a best-effort `denied` audit row then rethrow.
 *
 * Call sites supply their own `action` / `targetType` / `targetId` /
 * `requestId` / `authMethod` so semantics stay per-router. Audit append is
 * always best-effort and never suppresses the reauth error.
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
    try {
      const reason =
        params.resolveDeniedReason === undefined
          ? (params.reason ?? null)
          : ((await params.resolveDeniedReason()) ?? null);

      await new PlatformAuditService(params.serverDB).append({
        action: params.action,
        actorUserId: params.actorUserId,
        afterDiff: { error: 'reauth_required' },
        ...(params.beforeDiff !== undefined ? { beforeDiff: params.beforeDiff } : {}),
        reason,
        ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
        result: 'denied',
        targetId: params.targetId ?? null,
        targetType: params.targetType,
      });
    } catch (auditError) {
      if (params.auditFailureLog !== false) {
        const message = params.auditFailureLog ?? '[admin.reauth] reauth denied audit failed';
        const meta = params.auditFailureMeta ?? { action: params.action };
        console.error(message, {
          ...meta,
          errorClass: auditError instanceof Error ? auditError.name : 'UnknownError',
        });
      }
    }
    throw error;
  }
};
