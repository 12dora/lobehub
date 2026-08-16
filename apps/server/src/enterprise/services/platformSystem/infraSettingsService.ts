import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import nodemailer from 'nodemailer';

import { emailEnv } from '@/envs/email';
import { fileEnv } from '@/envs/file';
import type {
  AdminSystemGetInfraSettings,
  AdminSystemInfraDependency,
  AdminSystemTestDependencyReason,
} from '@/server/enterprise/contracts/adminSystem';
import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import { PlatformSecretService } from '../../security/secret';
import type { ResolvedEmailConfig } from './infraDependencyConfig';
import {
  mailHealth,
  maskAccessId,
  objectStorageHealth,
  parseFromField,
  resolveEmailConfig,
  resolveKeyManagementOverview,
} from './infraDependencyConfig';

const PROBE_TIMEOUT_MS = 8000;
const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';

type EnvBag = Record<string, string | undefined>;

export type InfraProbeReason = AdminSystemTestDependencyReason;

export class InfraProbeError extends Error {
  readonly reason: InfraProbeReason;

  constructor(reason: InfraProbeReason) {
    super(reason);
    this.name = 'InfraProbeError';
    this.reason = reason;
  }
}

export interface InfraS3Client {
  destroy: () => void;
  send: (
    command: HeadBucketCommand | ListObjectsV2Command,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<unknown>;
}

export interface InfraMailTransport {
  close?: () => void;
  verify: () => Promise<unknown>;
}

export interface InfraSecretService {
  getActiveKeyId: () => Promise<string>;
}

export interface InfraOutboundFetch {
  (
    input: string | URL,
    init?: {
      headers?: Record<string, string>;
      method?: string;
      secretBearing?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ ok: boolean; status: number }>;
}

export interface InfraSettingsServiceOptions {
  createMailTransport?: (
    config: Extract<ResolvedEmailConfig, { kind: 'smtp' }>,
  ) => InfraMailTransport;
  createS3Client?: (
    config: Extract<ReturnType<typeof resolveFileS3Config>, { kind: 'complete' }>,
  ) => InfraS3Client;
  env?: EnvBag;
  now?: () => Date;
  outboundFetch?: InfraOutboundFetch;
  secretServiceFromEnv?: (env: EnvBag) => InfraSecretService | null;
}

const resolveEnv = (override?: EnvBag): EnvBag => {
  if (override) return override;
  return {
    EMAIL_SERVICE_PROVIDER: emailEnv.EMAIL_SERVICE_PROVIDER,
    PLATFORM_KEY_PROVIDER: process.env.PLATFORM_KEY_PROVIDER,
    PLATFORM_MASTER_KEY: process.env.PLATFORM_MASTER_KEY,
    PLATFORM_MASTER_KEY_ID: process.env.PLATFORM_MASTER_KEY_ID,
    RESEND_API_KEY: emailEnv.RESEND_API_KEY,
    RESEND_FROM: emailEnv.RESEND_FROM,
    S3_ACCESS_KEY_ID: fileEnv.S3_ACCESS_KEY_ID,
    S3_BUCKET: fileEnv.S3_BUCKET,
    S3_ENABLE_PATH_STYLE: fileEnv.S3_ENABLE_PATH_STYLE ? '1' : undefined,
    S3_ENDPOINT: fileEnv.S3_ENDPOINT,
    S3_PUBLIC_DOMAIN: fileEnv.S3_PUBLIC_DOMAIN,
    S3_REGION: fileEnv.S3_REGION,
    S3_SECRET_ACCESS_KEY: fileEnv.S3_SECRET_ACCESS_KEY,
    SMTP_FROM: emailEnv.SMTP_FROM,
    SMTP_HOST: emailEnv.SMTP_HOST,
    SMTP_PASS: emailEnv.SMTP_PASS,
    SMTP_PORT: emailEnv.SMTP_PORT === undefined ? undefined : String(emailEnv.SMTP_PORT),
    SMTP_SECURE: emailEnv.SMTP_SECURE ? 'true' : undefined,
    SMTP_USER: emailEnv.SMTP_USER,
    VAULT_ADDR: process.env.VAULT_ADDR,
    VAULT_APPROLE_MOUNT_PATH: process.env.VAULT_APPROLE_MOUNT_PATH,
    VAULT_APPROLE_ROLE_ID: process.env.VAULT_APPROLE_ROLE_ID,
    VAULT_APPROLE_SECRET_ID: process.env.VAULT_APPROLE_SECRET_ID,
    VAULT_KV_MOUNT_PATH: process.env.VAULT_KV_MOUNT_PATH,
    VAULT_KV_SECRET_PATH: process.env.VAULT_KV_SECRET_PATH,
    VAULT_TOKEN: process.env.VAULT_TOKEN,
  };
};

const isTimeoutError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  return (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    name === 'TimeoutExpired' ||
    /timeout|timed out|aborted/i.test(message)
  );
};

const isUnauthorizedError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  const status =
    'status' in error && typeof error.status === 'number'
      ? error.status
      : '$metadata' in error &&
          error.$metadata &&
          typeof error.$metadata === 'object' &&
          'httpStatusCode' in error.$metadata &&
          typeof error.$metadata.httpStatusCode === 'number'
        ? error.$metadata.httpStatusCode
        : undefined;
  return (
    status === 401 ||
    status === 403 ||
    /accessdenied|invalidaccesskey|unauthorized|forbidden|signature/i.test(`${name} ${message}`)
  );
};

const withTimeout = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || isTimeoutError(error)) {
      throw new InfraProbeError('timeout');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const defaultCreateS3Client: NonNullable<InfraSettingsServiceOptions['createS3Client']> = (
  config,
) =>
  new S3Client({
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    region: config.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });

const defaultCreateMailTransport: NonNullable<
  InfraSettingsServiceOptions['createMailTransport']
> = (config) =>
  nodemailer.createTransport({
    auth: { pass: config.pass, user: config.user },
    connectionTimeout: PROBE_TIMEOUT_MS,
    greetingTimeout: PROBE_TIMEOUT_MS,
    host: config.host,
    port: config.port,
    secure: config.secure,
    socketTimeout: PROBE_TIMEOUT_MS,
  });

const defaultOutboundFetch: InfraOutboundFetch = async (input, init) => {
  const outbound = createSafeOutboundHttpClient({
    mode:
      typeof input === 'string' && input.startsWith('https://api.resend.com')
        ? 'public-only'
        : 'allow-private',
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return outbound.fetch(input, {
    headers: init?.headers,
    method: init?.method,
    secretBearing: init?.secretBearing,
    timeoutMs: init?.timeoutMs ?? PROBE_TIMEOUT_MS,
  });
};

const defaultSecretServiceFromEnv = (env: EnvBag): InfraSecretService | null =>
  PlatformSecretService.tryFromEnv(env);

const probeObjectStorage = async (
  env: EnvBag,
  createS3Client: NonNullable<InfraSettingsServiceOptions['createS3Client']>,
): Promise<void> => {
  const resolved = resolveFileS3Config(env);
  if (resolved.kind === 'unconfigured') throw new InfraProbeError('not_configured');
  if (resolved.kind === 'incomplete') throw new InfraProbeError('configuration_incomplete');

  const client = createS3Client(resolved);
  try {
    await withTimeout(async (signal) => {
      try {
        await client.send(new HeadBucketCommand({ Bucket: resolved.bucket }), {
          abortSignal: signal,
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        if (/notimplemented|unknownoperation|invalidrequest/i.test(name)) {
          await client.send(new ListObjectsV2Command({ Bucket: resolved.bucket, MaxKeys: 1 }), {
            abortSignal: signal,
          });
          return;
        }
        throw error;
      }
    });
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isUnauthorizedError(error)) throw new InfraProbeError('unauthorized');
    throw new InfraProbeError('unreachable');
  } finally {
    client.destroy();
  }
};

const probeMail = async (
  env: EnvBag,
  options: {
    createMailTransport: NonNullable<InfraSettingsServiceOptions['createMailTransport']>;
    outboundFetch: InfraOutboundFetch;
  },
): Promise<void> => {
  const resolved = resolveEmailConfig(env);
  if (resolved.kind === 'unconfigured') throw new InfraProbeError('not_configured');
  if (resolved.kind === 'incomplete') throw new InfraProbeError('configuration_incomplete');

  if (resolved.kind === 'resend') {
    try {
      const response = await options.outboundFetch(RESEND_DOMAINS_URL, {
        headers: { Authorization: `Bearer ${resolved.apiKey}` },
        method: 'GET',
        secretBearing: true,
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (response.status === 401 || response.status === 403) {
        throw new InfraProbeError('unauthorized');
      }
      if (!response.ok) throw new InfraProbeError('unreachable');
    } catch (error) {
      if (error instanceof InfraProbeError) throw error;
      if (isTimeoutError(error)) throw new InfraProbeError('timeout');
      throw new InfraProbeError('unreachable');
    }
    return;
  }

  const transporter = options.createMailTransport(resolved);
  try {
    await withTimeout(async (signal) => {
      const verify = transporter.verify();
      const abort = new Promise<never>((_, reject) => {
        const onAbort = () => reject(new InfraProbeError('timeout'));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([verify, abort]);
    });
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isTimeoutError(error)) throw new InfraProbeError('timeout');
    if (isUnauthorizedError(error)) throw new InfraProbeError('unauthorized');
    throw new InfraProbeError('unreachable');
  } finally {
    transporter.close?.();
  }
};

const probeKeyManagement = async (
  env: EnvBag,
  secretServiceFromEnv: (env: EnvBag) => InfraSecretService | null,
): Promise<void> => {
  let service: InfraSecretService | null;
  try {
    service = secretServiceFromEnv(env);
  } catch {
    throw new InfraProbeError('configuration_incomplete');
  }
  if (!service) throw new InfraProbeError('not_configured');

  try {
    await withTimeout(async () => {
      await service.getActiveKeyId();
    });
  } catch (error) {
    if (error instanceof InfraProbeError) throw error;
    if (isUnauthorizedError(error)) throw new InfraProbeError('unauthorized');
    if (isTimeoutError(error)) throw new InfraProbeError('timeout');
    throw new InfraProbeError('unreachable');
  }
};

export class InfraSettingsService {
  private readonly createMailTransport: NonNullable<
    InfraSettingsServiceOptions['createMailTransport']
  >;
  private readonly createS3Client: NonNullable<InfraSettingsServiceOptions['createS3Client']>;
  private readonly env: EnvBag;
  private readonly now: () => Date;
  private readonly outboundFetch: InfraOutboundFetch;
  private readonly secretServiceFromEnv: (env: EnvBag) => InfraSecretService | null;

  constructor(options: InfraSettingsServiceOptions = {}) {
    this.env = resolveEnv(options.env);
    this.now = options.now ?? (() => new Date());
    this.createS3Client = options.createS3Client ?? defaultCreateS3Client;
    this.createMailTransport = options.createMailTransport ?? defaultCreateMailTransport;
    this.outboundFetch = options.outboundFetch ?? defaultOutboundFetch;
    this.secretServiceFromEnv = options.secretServiceFromEnv ?? defaultSecretServiceFromEnv;
  }

  getInfraSettings = (): AdminSystemGetInfraSettings => {
    const objectStorage = objectStorageHealth(this.env);
    const mail = mailHealth(this.env);
    const s3 = resolveFileS3Config(this.env);
    const email = resolveEmailConfig(this.env);
    const keyManagement = resolveKeyManagementOverview(this.env);

    return {
      keyManagement,
      mail: {
        errorCategory: mail.errorCategory,
        fromAddress: email.kind === 'smtp' || email.kind === 'resend' ? email.from : null,
        host: email.kind === 'smtp' ? email.host : null,
        port: email.kind === 'smtp' ? email.port : null,
        provider:
          email.kind === 'resend' || (email.kind === 'incomplete' && email.provider === 'resend')
            ? 'resend'
            : email.kind === 'unconfigured'
              ? 'unconfigured'
              : 'smtp',
        secure: email.kind === 'smtp' ? email.secure : null,
        senderName: email.kind === 'smtp' || email.kind === 'resend' ? email.senderName : null,
        status: mail.status,
      },
      objectStorage: {
        accessId: maskAccessId(this.env.S3_ACCESS_KEY_ID),
        bucket: s3.kind === 'complete' ? s3.bucket : this.env.S3_BUCKET?.trim() || null,
        endpoint: s3.kind === 'complete' ? s3.endpoint : this.env.S3_ENDPOINT?.trim() || null,
        errorCategory: objectStorage.errorCategory,
        pathStyle:
          s3.kind === 'complete' ? s3.forcePathStyle : this.env.S3_ENABLE_PATH_STYLE === '1',
        publicDomain:
          s3.kind === 'complete'
            ? (s3.publicDomain ?? null)
            : this.env.S3_PUBLIC_DOMAIN?.trim() || null,
        region: s3.kind === 'complete' ? s3.region : null,
        status: objectStorage.status,
      },
      snapshotAt: this.now(),
    };
  };

  testDependency = async (input: {
    dependency: AdminSystemInfraDependency;
  }): Promise<{
    checkedAt: Date;
    latencyMs: number;
    message?: InfraProbeReason;
    ok: boolean;
  }> => {
    const started = Date.now();
    const checkedAt = this.now();
    try {
      if (input.dependency === 'objectStorage') {
        await probeObjectStorage(this.env, this.createS3Client);
      } else if (input.dependency === 'mail') {
        await probeMail(this.env, {
          createMailTransport: this.createMailTransport,
          outboundFetch: this.outboundFetch,
        });
      } else {
        await probeKeyManagement(this.env, this.secretServiceFromEnv);
      }
      return { checkedAt, latencyMs: Date.now() - started, ok: true };
    } catch (error) {
      const reason = error instanceof InfraProbeError ? error.reason : 'unreachable';
      return {
        checkedAt,
        latencyMs: Date.now() - started,
        message: reason,
        ok: false,
      };
    }
  };
}

export { maskAccessId, parseFromField };
