import { PlatformSecretService } from '@/server/enterprise/security/secret';

/**
 * How callers obtain {@link PlatformSecretService}:
 *
 * ```
 * import { PlatformSecretService } from '@/server/enterprise/security/secret';
 * const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
 * ```
 *
 * Same factory as `networkProxy/secrets.ts` and `contentModeration/secrets.ts`.
 */
export const obtainPlatformSecretService = (): PlatformSecretService | null =>
  PlatformSecretService.fromEnvOrThrowIfEnterprise();

const requireSecretService = (): PlatformSecretService => {
  const service = obtainPlatformSecretService();
  if (!service) {
    throw new Error('Platform secret service is not configured');
  }
  return service;
};

/** Seal an S3 secret access key, SMTP password, or Resend API key. */
export const sealInfraSecret = async (plain: string): Promise<string> =>
  requireSecretService().encrypt(plain);

/** Open a previously sealed infrastructure secret. */
export const openInfraSecret = async (ciphertext: string): Promise<string> =>
  requireSecretService().decrypt(ciphertext);
