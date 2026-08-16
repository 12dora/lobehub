import { assertDangerousReauthWithAudit } from '../../guards/reauth';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { PlatformSecretService } from '../../security/secret';
import type { AuditAction } from '../../services/audit/auditActionCatalog';
import { IdentityProviderSecretStore } from '../../services/identityProvider/secretStore';
import type { createAdminIdentityProviderRuntime } from './identityProvidersSupport';

export const identitySecretMutationRequiresReauth = (mutation: {
  operation: 'clear' | 'keep' | 'replace';
}): boolean => mutation.operation === 'replace' || mutation.operation === 'clear';

/**
 * Redact known client-secret values and pattern-detected secret material from an
 * admin-supplied reason. Used for both denied-reauth audits and success-path audits
 * so opaque secrets pasted into free-text reason never land in the append-only log.
 */
const sanitizeIdentityReason = async (input: {
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}): Promise<string | null> => {
  if (containsEnterpriseSecretMaterial(input.reason)) return null;
  const credentialValues = (input.replacementSecrets ?? []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (input.currentSecretTargetId) {
    try {
      const secretService = PlatformSecretService.fromEnvOrThrowIfEnterprise();
      if (!secretService) return null;
      const currentSecret = await new IdentityProviderSecretStore(
        input.serverDB,
        secretService,
      ).resolveCurrentClientSecret(input.currentSecretTargetId);
      // Fail closed: without the current secret we cannot prove the reason is free of it.
      if (!currentSecret) return null;
      credentialValues.push(currentSecret);
    } catch {
      // Secret store/outage: redact entire reason rather than risk persisting the opaque secret.
      return null;
    }
  }

  let reason = input.reason;
  for (const value of credentialValues.sort((a, b) => b.length - a.length)) {
    reason = reason.replaceAll(value, '[REDACTED]');
  }
  return containsEnterpriseSecretMaterial(reason) ? null : reason;
};

/** Always returns a safe reason string for mutation/audit paths (never the raw secret). */
export const requireSanitizedIdentityReason = async (input: {
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}): Promise<string> => {
  const sanitized = await sanitizeIdentityReason(input);
  return sanitized ?? '[REDACTED]';
};

interface ExistingIdentityProviderReasonInput {
  providerId: string;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
}

/**
 * Existing-provider mutations must always compare the reason with the stored
 * opaque client secret. Keeping providerId required here makes an unsafe
 * sanitization call impossible at those call sites.
 */
export const requireSanitizedExistingIdentityReason = ({
  providerId,
  ...input
}: ExistingIdentityProviderReasonInput): Promise<string> =>
  requireSanitizedIdentityReason({ ...input, currentSecretTargetId: providerId });

export const assertIdentityDangerousReauth = async (input: {
  action: AuditAction;
  actorUserId: string;
  authenticatedAt?: Date | null;
  authMethod?: Parameters<typeof assertDangerousReauthWithAudit>[0]['authMethod'];
  currentSecretTargetId?: string | null;
  reason: string;
  replacementSecrets?: unknown[];
  serverDB: Parameters<typeof createAdminIdentityProviderRuntime>[0];
  targetId: string;
}) =>
  assertDangerousReauthWithAudit({
    authenticatedAt: input.authenticatedAt,
    authMethod: input.authMethod,
    serverDB: input.serverDB,
    denied: {
      action: input.action,
      actorUserId: input.actorUserId,
      resolveDeniedReason: () => sanitizeIdentityReason(input),
      targetId: input.targetId,
      targetType: 'identity_provider',
    },
  });

export const assertExistingIdentityDangerousReauth = async (
  input: Omit<
    Parameters<typeof assertIdentityDangerousReauth>[0],
    'currentSecretTargetId' | 'targetId'
  > & { providerId: string },
) =>
  assertIdentityDangerousReauth({
    ...input,
    currentSecretTargetId: input.providerId,
    targetId: input.providerId,
  });
