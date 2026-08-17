import { HeadBucketCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import nodemailer from 'nodemailer';

import { getServerDB } from '@/database/core/db-adaptor';
import type {
  AdminSystemGetInfraSettings,
  AdminSystemInfraDependency,
  AdminSystemMailConfig,
  AdminSystemObjectStorageConfig,
  AdminSystemTestDependencyReason,
} from '@/server/enterprise/contracts/adminSystem';
import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';
import type { MailUpdate, ObjectStorageUpdate } from '@/types/platform/infraSettings';

import { createSafeOutboundHttpClient } from '../../security/outboundHttp';
import {
  envPreviewUrlExpireIn,
  getInfraSnapshot,
  getMailSettings,
  getObjectStorageSettings,
  mailSnapshotToEnvBag,
  objectStorageSnapshotToEnvBag,
  openInfraSecret,
  resolveInfraEnvBag,
} from '../infraSettings';
import {
  assertMailDestinationsAllowed,
  assertObjectStorageDestinationsAllowed,
  InfraSettingsDestinationError,
} from '../infraSettings/destinationPolicy';
import {
  INFRA_SECRET_REUSE_MESSAGE,
  mailDestinationTuple,
  mailTuplesEqual,
  objectStorageDestinationTuple,
  objectStorageTuplesEqual,
} from '../infraSettings/destinationTuple';
import {
  InfraSettingsSecretRequiredError,
  InfraSettingsSecretReuseError,
} from '../infraSettings/errors';
import type { InfraEnvBag, ResolvedEmailConfig } from './infraDependencyConfig';
import {
  mailHealth,
  maskAccessId,
  objectStorageHealth,
  parseFromField,
  resolveEmailConfig,
} from './infraDependencyConfig';

const PROBE_TIMEOUT_MS = 8000;
const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';

type EnvBag = InfraEnvBag;

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
  assertMailDestinations?: typeof assertMailDestinationsAllowed;
  assertObjectStorageDestinations?: typeof assertObjectStorageDestinationsAllowed;
  createMailTransport?: (
    config: Extract<ResolvedEmailConfig, { kind: 'smtp' }>,
  ) => InfraMailTransport;
  createS3Client?: (
    config: Extract<ReturnType<typeof resolveFileS3Config>, { kind: 'complete' }>,
  ) => InfraS3Client;
  env?: EnvBag;
  now?: () => Date;
  outboundFetch?: InfraOutboundFetch;
}

const resolveEnv = (override?: EnvBag): EnvBag => resolveInfraEnvBag(override);

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

export class InfraSettingsService {
  private readonly createMailTransport: NonNullable<
    InfraSettingsServiceOptions['createMailTransport']
  >;
  private readonly assertMailDestinations: typeof assertMailDestinationsAllowed;
  private readonly assertObjectStorageDestinations: typeof assertObjectStorageDestinationsAllowed;
  private readonly createS3Client: NonNullable<InfraSettingsServiceOptions['createS3Client']>;
  private readonly env: EnvBag;
  private readonly envOverride: boolean;
  private readonly now: () => Date;
  private readonly outboundFetch: InfraOutboundFetch;

  constructor(options: InfraSettingsServiceOptions = {}) {
    this.envOverride = options.env !== undefined;
    this.env = resolveEnv(options.env);
    this.now = options.now ?? (() => new Date());
    this.createS3Client = options.createS3Client ?? defaultCreateS3Client;
    this.createMailTransport = options.createMailTransport ?? defaultCreateMailTransport;
    this.outboundFetch = options.outboundFetch ?? defaultOutboundFetch;
    this.assertObjectStorageDestinations =
      options.assertObjectStorageDestinations ?? assertObjectStorageDestinationsAllowed;
    this.assertMailDestinations = options.assertMailDestinations ?? assertMailDestinationsAllowed;
  }

  getInfraSettings = async (): Promise<AdminSystemGetInfraSettings> => {
    if (this.envOverride) {
      return this.projectFromEnv(this.env, {
        mail: {
          enabled: false,
          hasResendApiKey: Boolean(this.env.RESEND_API_KEY),
          hasSmtpPass: Boolean(this.env.SMTP_PASS),
          revision: 0,
          smtpUser: this.env.SMTP_USER?.trim() || null,
          source: 'env',
        },
        objectStorage: {
          accessIdMode: 'mask',
          enabled: false,
          hasSecretAccessKey: Boolean(this.env.S3_SECRET_ACCESS_KEY),
          previewUrlExpireIn: envPreviewUrlExpireIn(this.env),
          revision: 0,
          setAcl: this.env.S3_SET_ACL === '1',
          source: 'env',
        },
      });
    }

    const db = await getServerDB();
    const [snapshot, storageRow, mailRow] = await Promise.all([
      getInfraSnapshot(),
      getObjectStorageSettings(db),
      getMailSettings(db),
    ]);
    const storageBag = objectStorageSnapshotToEnvBag(snapshot.objectStorage);
    const mailBag = mailSnapshotToEnvBag(snapshot.mail);
    const merged: EnvBag = { ...this.env, ...storageBag, ...mailBag };

    return this.projectFromEnv(merged, {
      mail: {
        enabled: mailRow.config.enabled,
        hasResendApiKey:
          snapshot.mail.source === 'db'
            ? Boolean(mailRow.config.resend?.apiKeyCiphertext)
            : Boolean(this.env.RESEND_API_KEY),
        hasSmtpPass:
          snapshot.mail.source === 'db'
            ? Boolean(mailRow.config.smtp?.passCiphertext)
            : Boolean(this.env.SMTP_PASS),
        revision: mailRow.revision,
        // Per-card all-or-nothing: the read view never mixes stored (db) values into an
        // env-sourced card, otherwise a reverted override would keep showing its old user.
        smtpUser:
          snapshot.mail.kind === 'smtp'
            ? snapshot.mail.user
            : (snapshot.mail.source === 'db'
                ? mailRow.config.smtp?.user
                : this.env.SMTP_USER?.trim()) || null,
        source: snapshot.mail.source,
      },
      objectStorage: {
        accessIdMode: snapshot.objectStorage.source === 'db' ? 'full' : 'mask',
        enabled: storageRow.config.enabled,
        hasSecretAccessKey:
          snapshot.objectStorage.source === 'db'
            ? Boolean(storageRow.config.secretAccessKeyCiphertext)
            : Boolean(this.env.S3_SECRET_ACCESS_KEY),
        previewUrlExpireIn: snapshot.objectStorage.previewUrlExpireIn,
        revision: storageRow.revision,
        setAcl:
          snapshot.objectStorage.kind === 'complete'
            ? snapshot.objectStorage.setAcl
            : storageRow.config.setAcl,
        source: snapshot.objectStorage.source,
      },
    });
  };

  testDependency = async (input: {
    dependency: AdminSystemInfraDependency;
    draft?: AdminSystemMailConfig | AdminSystemObjectStorageConfig;
  }): Promise<{
    checkedAt: Date;
    latencyMs: number;
    message?: InfraProbeReason;
    ok: boolean;
  }> => {
    const started = Date.now();
    const checkedAt = this.now();
    try {
      const draftBag = input.draft
        ? await this.envBagFromDraft(input.dependency, input.draft)
        : null;
      if (draftBag === 'configuration_incomplete') {
        throw new InfraProbeError('configuration_incomplete');
      }
      const env = draftBag ?? (await this.effectiveEnvFor(input.dependency));

      if (input.dependency === 'objectStorage') {
        if (input.draft) {
          await this.assertObjectStorageDestinations(input.draft as AdminSystemObjectStorageConfig);
        }
        await probeObjectStorage(env, this.createS3Client);
      } else {
        if (input.draft) {
          await this.assertMailDestinations(input.draft as AdminSystemMailConfig);
        }
        await probeMail(env, {
          createMailTransport: this.createMailTransport,
          outboundFetch: this.outboundFetch,
        });
      }
      return { checkedAt, latencyMs: Date.now() - started, ok: true };
    } catch (error) {
      if (
        error instanceof InfraSettingsSecretReuseError ||
        error instanceof InfraSettingsSecretRequiredError ||
        error instanceof InfraSettingsDestinationError
      ) {
        throw error;
      }
      const reason = error instanceof InfraProbeError ? error.reason : 'unreachable';
      return {
        checkedAt,
        latencyMs: Date.now() - started,
        message: reason,
        ok: false,
      };
    }
  };

  private projectFromEnv = (
    env: EnvBag,
    extras: {
      mail: {
        enabled: boolean;
        hasResendApiKey: boolean;
        hasSmtpPass: boolean;
        revision: number;
        smtpUser: string | null;
        source: 'db' | 'env';
      };
      objectStorage: {
        accessIdMode: 'full' | 'mask';
        enabled: boolean;
        hasSecretAccessKey: boolean;
        previewUrlExpireIn: number | null;
        revision: number;
        setAcl: boolean;
        source: 'db' | 'env';
      };
    },
  ): AdminSystemGetInfraSettings => {
    const objectStorage = objectStorageHealth(env);
    const mail = mailHealth(env);
    const s3 = resolveFileS3Config(env);
    const email = resolveEmailConfig(env);
    const rawAccessId =
      s3.kind === 'complete' ? s3.accessKeyId : env.S3_ACCESS_KEY_ID?.trim() || undefined;

    return {
      mail: {
        enabled: extras.mail.enabled,
        errorCategory: mail.errorCategory,
        fromAddress: email.kind === 'smtp' || email.kind === 'resend' ? email.from : null,
        hasResendApiKey: extras.mail.hasResendApiKey,
        hasSmtpPass: extras.mail.hasSmtpPass,
        host: email.kind === 'smtp' ? email.host : null,
        port: email.kind === 'smtp' ? email.port : null,
        provider:
          email.kind === 'resend' || (email.kind === 'incomplete' && email.provider === 'resend')
            ? 'resend'
            : email.kind === 'unconfigured'
              ? 'unconfigured'
              : 'smtp',
        revision: extras.mail.revision,
        secure: email.kind === 'smtp' ? email.secure : null,
        senderName: email.kind === 'smtp' || email.kind === 'resend' ? email.senderName : null,
        smtpUser: extras.mail.smtpUser,
        source: extras.mail.source,
        status: mail.status,
      },
      objectStorage: {
        accessId:
          extras.objectStorage.accessIdMode === 'full'
            ? (rawAccessId ?? null)
            : maskAccessId(rawAccessId),
        bucket: s3.kind === 'complete' ? s3.bucket : env.S3_BUCKET?.trim() || null,
        enabled: extras.objectStorage.enabled,
        endpoint: s3.kind === 'complete' ? s3.endpoint : env.S3_ENDPOINT?.trim() || null,
        errorCategory: objectStorage.errorCategory,
        hasSecretAccessKey: extras.objectStorage.hasSecretAccessKey,
        pathStyle: s3.kind === 'complete' ? s3.forcePathStyle : env.S3_ENABLE_PATH_STYLE === '1',
        previewUrlExpireIn: extras.objectStorage.previewUrlExpireIn,
        publicDomain:
          s3.kind === 'complete' ? (s3.publicDomain ?? null) : env.S3_PUBLIC_DOMAIN?.trim() || null,
        region: s3.kind === 'complete' ? s3.region : env.S3_REGION?.trim() || null,
        revision: extras.objectStorage.revision,
        setAcl: extras.objectStorage.setAcl,
        source: extras.objectStorage.source,
        status: objectStorage.status,
      },
      snapshotAt: this.now(),
    };
  };

  private effectiveEnvFor = async (dependency: 'mail' | 'objectStorage'): Promise<EnvBag> => {
    if (this.envOverride) return this.env;
    const snapshot = await getInfraSnapshot();
    if (dependency === 'objectStorage') {
      return { ...this.env, ...objectStorageSnapshotToEnvBag(snapshot.objectStorage) };
    }
    return { ...this.env, ...mailSnapshotToEnvBag(snapshot.mail) };
  };

  private envBagFromDraft = async (
    dependency: 'mail' | 'objectStorage',
    draft: AdminSystemMailConfig | AdminSystemObjectStorageConfig,
  ): Promise<EnvBag | 'configuration_incomplete'> => {
    if (dependency === 'objectStorage') {
      const config = draft as ObjectStorageUpdate;
      const secretAction = config.secretAccessKey ?? { action: 'keep' as const };
      if (secretAction.action === 'clear') return 'configuration_incomplete';
      const secret =
        secretAction.action === 'replace'
          ? secretAction.value
          : await this.resolveKeepSecret('objectStorage', objectStorageDestinationTuple(config));
      if (!secret) return 'configuration_incomplete';
      return {
        ...this.env,
        S3_ACCESS_KEY_ID: config.accessKeyId,
        S3_BUCKET: config.bucket,
        S3_ENABLE_PATH_STYLE: config.forcePathStyle ? '1' : undefined,
        S3_ENDPOINT:
          config.endpoint ??
          (config.region ? `https://s3.${config.region}.amazonaws.com` : undefined),
        S3_PREVIEW_URL_EXPIRE_IN:
          config.previewUrlExpireIn === undefined ? undefined : String(config.previewUrlExpireIn),
        S3_PUBLIC_DOMAIN: config.publicDomain,
        S3_REGION: config.region,
        S3_SECRET_ACCESS_KEY: secret,
        S3_SET_ACL: config.setAcl ? '1' : undefined,
      };
    }

    const config = draft as MailUpdate;
    if (config.provider === 'smtp') {
      const passAction = config.smtp?.pass ?? { action: 'keep' as const };
      if (passAction.action === 'clear') return 'configuration_incomplete';
      const pass =
        passAction.action === 'replace'
          ? passAction.value
          : await this.resolveKeepSecret(
              'mail-smtp',
              mailDestinationTuple({ provider: 'smtp', smtp: config.smtp }),
            );
      if (!pass) return 'configuration_incomplete';
      const from = config.senderName
        ? `"${config.senderName}" <${config.fromAddress}>`
        : config.fromAddress;
      return {
        ...this.env,
        EMAIL_SERVICE_PROVIDER: 'nodemailer',
        SMTP_FROM: from,
        SMTP_HOST: config.smtp!.host,
        SMTP_PASS: pass,
        SMTP_PORT: String(config.smtp!.port),
        SMTP_SECURE: config.smtp!.secure ? 'true' : undefined,
        SMTP_USER: config.smtp!.user,
      };
    }

    const keyAction = config.resend?.apiKey ?? { action: 'keep' as const };
    if (keyAction.action === 'clear') return 'configuration_incomplete';
    const apiKey =
      keyAction.action === 'replace'
        ? keyAction.value
        : await this.resolveKeepSecret('mail-resend', mailDestinationTuple({ provider: 'resend' }));
    if (!apiKey) return 'configuration_incomplete';
    const from = config.senderName
      ? `"${config.senderName}" <${config.fromAddress}>`
      : config.fromAddress;
    return {
      ...this.env,
      EMAIL_SERVICE_PROVIDER: 'resend',
      RESEND_API_KEY: apiKey,
      RESEND_FROM: from,
    };
  };

  /**
   * Reuse a stored or env secret for draft `keep` only when the destination
   * tuple is unchanged versus the source the secret belongs to.
   */
  private resolveKeepSecret = async (
    kind: 'mail-resend' | 'mail-smtp' | 'objectStorage',
    draftTuple:
      ReturnType<typeof mailDestinationTuple> | ReturnType<typeof objectStorageDestinationTuple>,
  ): Promise<string | undefined> => {
    const field =
      kind === 'objectStorage' ? 'secretAccessKey' : kind === 'mail-smtp' ? 'pass' : 'apiKey';

    const stored = this.envOverride ? null : await this.loadStoredSecret(kind);
    if (stored?.secret) {
      const matches =
        kind === 'objectStorage'
          ? objectStorageTuplesEqual(
              draftTuple as ReturnType<typeof objectStorageDestinationTuple>,
              stored.tuple as ReturnType<typeof objectStorageDestinationTuple>,
            )
          : mailTuplesEqual(
              draftTuple as ReturnType<typeof mailDestinationTuple>,
              stored.tuple as ReturnType<typeof mailDestinationTuple>,
            );
      if (!matches) throw new InfraSettingsSecretReuseError(field, INFRA_SECRET_REUSE_MESSAGE);
      return stored.secret;
    }

    const envSecret =
      kind === 'objectStorage'
        ? this.env.S3_SECRET_ACCESS_KEY
        : kind === 'mail-smtp'
          ? this.env.SMTP_PASS
          : this.env.RESEND_API_KEY;
    if (!envSecret) return undefined;

    const envTuple =
      kind === 'objectStorage'
        ? objectStorageDestinationTuple({
            bucket: this.env.S3_BUCKET,
            endpoint: this.env.S3_ENDPOINT,
            region: this.env.S3_REGION,
          })
        : mailDestinationTuple({
            provider: kind === 'mail-resend' ? 'resend' : 'smtp',
            smtp:
              kind === 'mail-smtp'
                ? {
                    host: this.env.SMTP_HOST,
                    port: this.env.SMTP_PORT ? Number(this.env.SMTP_PORT) : undefined,
                    secure: this.env.SMTP_SECURE === 'true',
                    user: this.env.SMTP_USER,
                  }
                : undefined,
          });
    const matchesEnv =
      kind === 'objectStorage'
        ? objectStorageTuplesEqual(
            draftTuple as ReturnType<typeof objectStorageDestinationTuple>,
            envTuple as ReturnType<typeof objectStorageDestinationTuple>,
          )
        : mailTuplesEqual(
            draftTuple as ReturnType<typeof mailDestinationTuple>,
            envTuple as ReturnType<typeof mailDestinationTuple>,
          );
    if (!matchesEnv) throw new InfraSettingsSecretReuseError(field, INFRA_SECRET_REUSE_MESSAGE);
    return envSecret;
  };

  private loadStoredSecret = async (
    kind: 'mail-resend' | 'mail-smtp' | 'objectStorage',
  ): Promise<{
    secret: string;
    tuple:
      ReturnType<typeof mailDestinationTuple> | ReturnType<typeof objectStorageDestinationTuple>;
  } | null> => {
    try {
      const db = await getServerDB();
      if (kind === 'objectStorage') {
        const row = await getObjectStorageSettings(db);
        if (!row.config.secretAccessKeyCiphertext) return null;
        return {
          secret: await openInfraSecret(row.config.secretAccessKeyCiphertext),
          tuple: objectStorageDestinationTuple(row.config),
        };
      }
      const row = await getMailSettings(db);
      if (kind === 'mail-smtp') {
        if (!row.config.smtp?.passCiphertext) return null;
        return {
          secret: await openInfraSecret(row.config.smtp.passCiphertext),
          tuple: mailDestinationTuple(row.config),
        };
      }
      if (!row.config.resend?.apiKeyCiphertext) return null;
      return {
        secret: await openInfraSecret(row.config.resend.apiKeyCiphertext),
        tuple: mailDestinationTuple(row.config),
      };
    } catch {
      return null;
    }
  };
}

export { maskAccessId, parseFromField };
