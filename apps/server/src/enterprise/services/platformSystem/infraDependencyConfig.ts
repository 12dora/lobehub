import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import { PlatformSecretError, PlatformSecretService } from '../../security/secret';
import { isTimeoutError } from './infraProbes';

export type InfraEnvBag = Record<string, string | undefined>;

export type DependencyHealth = {
  errorCategory:
    'configuration_incomplete' | 'operation_unavailable' | 'passive_check_only' | 'timeout' | null;
  lastCheckedAt: Date | null;
  status: 'degraded' | 'disabled' | 'healthy' | 'unavailable' | 'unknown';
};

export const DEFAULT_SMTP_HOST = 'localhost';
export const DEFAULT_SMTP_PORT = 587;

export type ResolvedEmailConfig =
  | { kind: 'incomplete'; provider: 'resend' | 'smtp' }
  | { kind: 'unconfigured' }
  | {
      apiKey: string;
      from: string;
      kind: 'resend';
      senderName: string | null;
    }
  | {
      from: string;
      host: string;
      kind: 'smtp';
      pass: string;
      port: number;
      secure: boolean;
      senderName: string | null;
      user: string;
    };

const disabledHealth = (): DependencyHealth => ({
  errorCategory: null,
  lastCheckedAt: null,
  status: 'disabled',
});
const passiveHealth = (): DependencyHealth => ({
  errorCategory: 'passive_check_only',
  lastCheckedAt: null,
  status: 'unknown',
});
const incompleteHealth = (): DependencyHealth => ({
  errorCategory: 'configuration_incomplete',
  lastCheckedAt: null,
  status: 'degraded',
});

const trim = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next || undefined;
};

export const parseFromField = (
  value: string | undefined,
): { address: string | null; senderName: string | null } => {
  const trimmed = trim(value);
  if (!trimmed) return { address: null, senderName: null };
  const start = trimmed.indexOf('<');
  const end = trimmed.lastIndexOf('>');
  if (start >= 0 && end > start) {
    const address = trim(trimmed.slice(start + 1, end)) ?? null;
    const rawName = trimmed.slice(0, start).trim().replaceAll(/^"|"$/g, '');
    return { address, senderName: trim(rawName) ?? null };
  }
  return { address: trimmed, senderName: null };
};

export const maskAccessId = (value: string | undefined): string | null => {
  const trimmed = trim(value);
  if (!trimmed) return null;
  if (trimmed.length <= 8) return '****';
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
};

const smtpPortOf = (value: string | undefined): number => {
  if (!value?.trim()) return DEFAULT_SMTP_PORT;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : DEFAULT_SMTP_PORT;
};

/**
 * Effective EmailService / NodemailerImpl configuration.
 *
 * Omitted `EMAIL_SERVICE_PROVIDER` defaults to SMTP (nodemailer). SMTP requires
 * `SMTP_USER` + `SMTP_PASS`; host/port/TLS default to localhost/587/false; from
 * falls back to `SMTP_USER`. Resend is used only when the provider is `resend`.
 */
export const resolveEmailConfig = (env: InfraEnvBag): ResolvedEmailConfig => {
  const provider = env.EMAIL_SERVICE_PROVIDER?.trim().toLowerCase();
  if (provider === 'resend') {
    const apiKey = trim(env.RESEND_API_KEY);
    const parsed = parseFromField(env.RESEND_FROM);
    if (apiKey && parsed.address) {
      return { apiKey, from: parsed.address, kind: 'resend', senderName: parsed.senderName };
    }
    return { kind: 'incomplete', provider: 'resend' };
  }

  const user = trim(env.SMTP_USER);
  const pass = trim(env.SMTP_PASS);
  const host = trim(env.SMTP_HOST);
  const fromRaw = trim(env.SMTP_FROM) ?? user;
  const smtpHint = Boolean(user || pass || host || trim(env.SMTP_FROM) || trim(env.SMTP_PORT));
  const resendHint = Boolean(trim(env.RESEND_API_KEY) || trim(env.RESEND_FROM));

  if (user && pass && fromRaw) {
    const parsed = parseFromField(fromRaw);
    return {
      from: parsed.address ?? fromRaw,
      host: host ?? DEFAULT_SMTP_HOST,
      kind: 'smtp',
      pass,
      port: smtpPortOf(env.SMTP_PORT),
      secure: env.SMTP_SECURE === 'true',
      senderName: parsed.senderName,
      user,
    };
  }

  if (provider === 'nodemailer' || smtpHint || resendHint) {
    return { kind: 'incomplete', provider: 'smtp' };
  }
  return { kind: 'unconfigured' };
};

export const objectStorageHealth = (env: InfraEnvBag): DependencyHealth => {
  const resolved = resolveFileS3Config(env);
  if (resolved.kind === 'unconfigured') return disabledHealth();
  if (resolved.kind === 'incomplete') return incompleteHealth();
  return passiveHealth();
};

export const mailHealth = (env: InfraEnvBag): DependencyHealth => {
  const resolved = resolveEmailConfig(env);
  if (resolved.kind === 'unconfigured') return disabledHealth();
  if (resolved.kind === 'incomplete') return incompleteHealth();
  return passiveHealth();
};

export const keyManagementHealth = (env: InfraEnvBag): DependencyHealth => {
  try {
    const service = PlatformSecretService.tryFromEnv(env);
    return service ? passiveHealth() : disabledHealth();
  } catch {
    return incompleteHealth();
  }
};

const isKeyProbeTimeout = (error: unknown): boolean => {
  if (isTimeoutError(error)) return true;
  if (!(error instanceof PlatformSecretError) || !error.details) return false;
  const reason = error.details.reason;
  return reason === 'request-timeout' || reason === 'secret-id-provider-timeout';
};

/**
 * Live key-management check. Keeps tryFromEnv disabled / incomplete branches, then
 * `getActiveKeyId()` (Vault hits auth + KV; env validates the local KEK). Env
 * additionally encrypts and decrypts a fixed payload. Never returns key ids,
 * addresses, or ciphertext.
 */
export const probeKeyManagement = async (
  env: InfraEnvBag,
  now: () => Date = () => new Date(),
): Promise<DependencyHealth> => {
  let service: PlatformSecretService | null;
  try {
    service = PlatformSecretService.tryFromEnv(env);
  } catch {
    return incompleteHealth();
  }
  if (!service) return disabledHealth();

  const checkedAt = now();
  try {
    await service.getActiveKeyId();
    if (service.keyProviderId === 'env') {
      const ciphertext = await service.encrypt('health');
      const plaintext = await service.decrypt(ciphertext);
      if (plaintext !== 'health') {
        return {
          errorCategory: 'operation_unavailable',
          lastCheckedAt: checkedAt,
          status: 'unavailable',
        };
      }
    }
    return { errorCategory: null, lastCheckedAt: checkedAt, status: 'healthy' };
  } catch (error) {
    return {
      errorCategory: isKeyProbeTimeout(error) ? 'timeout' : 'operation_unavailable',
      lastCheckedAt: checkedAt,
      status: 'unavailable',
    };
  }
};
