import { isIP } from 'node:net';

import {
  createSafeOutboundHttpClient,
  type DnsResolver,
  isMetadataHostname,
  isMetadataIp,
  normalizeIp,
  type OutboundPolicyMode,
} from '../../security/outboundHttp';
import { SafeOutboundHttpError } from '../../security/outboundHttp/errors';

/**
 * Same switch as identity-provider / AI-catalog outbound mode:
 * unset or `1` → allow-private (on-prem default); explicit `0` → public-only.
 * Cloud metadata is denied in every mode.
 */
export const resolveInfraOutboundMode = (
  env: Record<string, string | undefined> = process.env,
): OutboundPolicyMode => {
  const raw = env.SSRF_ALLOW_PRIVATE_IP_ADDRESS;
  return raw === '0' ? 'public-only' : 'allow-private';
};

const isLinkLocalMetadataRange = (ip: string): boolean => {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  if (normalized.startsWith('169.254.')) return true;
  // AWS IMDS IPv6 prefix fd00:ec2::/48
  if (normalized.startsWith('fd00:0ec2:')) return true;
  return isMetadataIp(normalized);
};

export class InfraSettingsDestinationError extends Error {
  readonly field: string;

  constructor(field: string, cause?: unknown) {
    super('Destination is not allowed by the outbound policy');
    this.name = 'InfraSettingsDestinationError';
    this.field = field;
    if (cause instanceof Error) this.cause = cause;
  }
}

export interface AssertInfraDestinationOptions {
  env?: Record<string, string | undefined>;
  field?: string;
  resolve?: DnsResolver;
}

/**
 * Destination check at SAVE / PROBE time (not per-request rebinding protection).
 * Resolves DNS and applies the deployer outbound policy. Always denies cloud
 * metadata (169.254.0.0/16, fd00:ec2::/48, metadata hostnames) even when
 * private networks are allowed.
 */
export const assertInfraDestinationAllowed = async (
  target: { host: string; port?: number } | { url: string },
  options: AssertInfraDestinationOptions = {},
): Promise<void> => {
  const field = options.field ?? 'endpoint';
  const mode = resolveInfraOutboundMode(options.env);
  const rawUrl =
    'url' in target ? target.url : `https://${target.host}${target.port ? `:${target.port}` : ''}`;

  try {
    const client = createSafeOutboundHttpClient({
      mode,
      resolve: options.resolve,
      timeoutMs: 8000,
    });
    await client.assertAllowed(rawUrl);

    const hostname = new URL(rawUrl).hostname;
    if (isMetadataHostname(hostname)) {
      throw new InfraSettingsDestinationError(field);
    }
    const hostAsIp = isIP(hostname.replaceAll(/^\[|\]$/g, ''));
    if (hostAsIp && isLinkLocalMetadataRange(hostname)) {
      throw new InfraSettingsDestinationError(field);
    }
  } catch (error) {
    if (error instanceof InfraSettingsDestinationError) throw error;
    if (error instanceof SafeOutboundHttpError) {
      throw new InfraSettingsDestinationError(field, error);
    }
    throw new InfraSettingsDestinationError(field, error);
  }
};

export const assertObjectStorageDestinationsAllowed = async (
  config: { endpoint?: string | null; publicDomain?: string | null; region?: string | null },
  options: Omit<AssertInfraDestinationOptions, 'field'> = {},
): Promise<void> => {
  const endpoint =
    config.endpoint?.trim() ||
    (config.region?.trim() ? `https://s3.${config.region.trim()}.amazonaws.com` : '');
  if (endpoint) {
    await assertInfraDestinationAllowed({ url: endpoint }, { ...options, field: 'endpoint' });
  }
  if (config.publicDomain?.trim()) {
    await assertInfraDestinationAllowed(
      { url: config.publicDomain.trim() },
      { ...options, field: 'publicDomain' },
    );
  }
};

export const assertMailDestinationsAllowed = async (
  config: {
    provider?: string;
    smtp?: { host?: string | null; port?: number | null } | null;
  },
  options: Omit<AssertInfraDestinationOptions, 'field'> = {},
): Promise<void> => {
  if (config.provider !== 'smtp' || !config.smtp?.host) return;
  await assertInfraDestinationAllowed(
    { host: config.smtp.host, port: config.smtp.port ?? undefined },
    { ...options, field: 'host' },
  );
};
