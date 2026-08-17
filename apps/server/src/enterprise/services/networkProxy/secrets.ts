import { PlatformSecretService } from '@/server/enterprise/security/secret';

/**
 * How callers obtain {@link PlatformSecretService}:
 *
 * ```
 * import { PlatformSecretService } from '@/server/enterprise/security/secret';
 * const secrets = PlatformSecretService.fromEnvOrThrowIfEnterprise();
 * ```
 *
 * Same factory as `contentModeration/secrets.ts`.
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

/** Seal a subscription URL, manual payload, or static-proxy password. */
export const sealNetworkProxySecret = async (plain: string): Promise<string> =>
  requireSecretService().encrypt(plain);

/** Open a previously sealed network-proxy secret. */
export const openNetworkProxySecret = async (ciphertext: string): Promise<string> =>
  requireSecretService().decrypt(ciphertext);
