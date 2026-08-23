import { getServerDB } from '@/database/core/db-adaptor';
import type {
  AdminSystemMailConfig,
  AdminSystemObjectStorageConfig,
} from '@/server/enterprise/contracts/adminSystem';
import type { MailUpdate, ObjectStorageUpdate } from '@/types/platform/infraSettings';

import { getMailSettings, getObjectStorageSettings, openInfraSecret } from '../infraSettings';
import {
  INFRA_SECRET_REUSE_MESSAGE,
  mailDestinationTuple,
  mailTuplesEqual,
  objectStorageDestinationTuple,
  objectStorageTuplesEqual,
} from '../infraSettings/destinationTuple';
import { InfraSettingsSecretReuseError } from '../infraSettings/errors';
import type { EnvBag } from './infraSettingsTypes';

type KeepSecretKind = 'mail-resend' | 'mail-smtp' | 'objectStorage';
type MailTuple = ReturnType<typeof mailDestinationTuple>;
type ObjectStorageTuple = ReturnType<typeof objectStorageDestinationTuple>;
type DestinationTuple = MailTuple | ObjectStorageTuple;

function keepSecretField(kind: KeepSecretKind): 'apiKey' | 'pass' | 'secretAccessKey' {
  if (kind === 'objectStorage') return 'secretAccessKey';
  if (kind === 'mail-smtp') return 'pass';
  return 'apiKey';
}

function destinationsMatch(
  kind: KeepSecretKind,
  draftTuple: DestinationTuple,
  otherTuple: DestinationTuple,
): boolean {
  if (kind === 'objectStorage') {
    return objectStorageTuplesEqual(
      draftTuple as ObjectStorageTuple,
      otherTuple as ObjectStorageTuple,
    );
  }
  return mailTuplesEqual(draftTuple as MailTuple, otherTuple as MailTuple);
}

function envSecretForKind(kind: KeepSecretKind, env: EnvBag): string | undefined {
  if (kind === 'objectStorage') return env.S3_SECRET_ACCESS_KEY;
  if (kind === 'mail-smtp') return env.SMTP_PASS;
  return env.RESEND_API_KEY;
}

function envDestinationTuple(kind: KeepSecretKind, env: EnvBag): DestinationTuple {
  if (kind === 'objectStorage') {
    return objectStorageDestinationTuple({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
    });
  }
  return mailDestinationTuple({
    provider: kind === 'mail-resend' ? 'resend' : 'smtp',
    smtp:
      kind === 'mail-smtp'
        ? {
            host: env.SMTP_HOST,
            port: env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined,
            secure: env.SMTP_SECURE === 'true',
            user: env.SMTP_USER,
          }
        : undefined,
  });
}

async function loadStoredSecret(
  kind: KeepSecretKind,
): Promise<{ secret: string; tuple: DestinationTuple } | null> {
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
}

/**
 * Reuse a stored or env secret for draft `keep` only when the destination
 * tuple is unchanged versus the source the secret belongs to.
 */
export async function resolveKeepSecret(
  kind: KeepSecretKind,
  draftTuple: DestinationTuple,
  params: { env: EnvBag; envOverride: boolean },
): Promise<string | undefined> {
  const field = keepSecretField(kind);

  const stored = params.envOverride ? null : await loadStoredSecret(kind);
  if (stored?.secret) {
    if (!destinationsMatch(kind, draftTuple, stored.tuple)) {
      throw new InfraSettingsSecretReuseError(field, INFRA_SECRET_REUSE_MESSAGE);
    }
    return stored.secret;
  }

  const envSecret = envSecretForKind(kind, params.env);
  if (!envSecret) return undefined;

  const envTuple = envDestinationTuple(kind, params.env);
  if (!destinationsMatch(kind, draftTuple, envTuple)) {
    throw new InfraSettingsSecretReuseError(field, INFRA_SECRET_REUSE_MESSAGE);
  }
  return envSecret;
}

async function envBagFromObjectStorageDraft(
  config: ObjectStorageUpdate,
  env: EnvBag,
  envOverride: boolean,
): Promise<EnvBag | 'configuration_incomplete'> {
  const secretAction = config.secretAccessKey ?? { action: 'keep' as const };
  if (secretAction.action === 'clear') return 'configuration_incomplete';
  const secret =
    secretAction.action === 'replace'
      ? secretAction.value
      : await resolveKeepSecret('objectStorage', objectStorageDestinationTuple(config), {
          env,
          envOverride,
        });
  if (!secret) return 'configuration_incomplete';
  return {
    ...env,
    S3_ACCESS_KEY_ID: config.accessKeyId,
    S3_BUCKET: config.bucket,
    S3_ENABLE_PATH_STYLE: config.forcePathStyle ? '1' : undefined,
    S3_ENDPOINT:
      config.endpoint ?? (config.region ? `https://s3.${config.region}.amazonaws.com` : undefined),
    S3_PREVIEW_URL_EXPIRE_IN:
      config.previewUrlExpireIn === undefined ? undefined : String(config.previewUrlExpireIn),
    S3_PUBLIC_DOMAIN: config.publicDomain,
    S3_REGION: config.region,
    S3_SECRET_ACCESS_KEY: secret,
    S3_SET_ACL: config.setAcl ? '1' : undefined,
  };
}

function mailFromAddress(config: MailUpdate): string {
  return config.senderName ? `"${config.senderName}" <${config.fromAddress}>` : config.fromAddress;
}

async function envBagFromSmtpDraft(
  config: MailUpdate,
  env: EnvBag,
  envOverride: boolean,
): Promise<EnvBag | 'configuration_incomplete'> {
  const passAction = config.smtp?.pass ?? { action: 'keep' as const };
  if (passAction.action === 'clear') return 'configuration_incomplete';
  const pass =
    passAction.action === 'replace'
      ? passAction.value
      : await resolveKeepSecret(
          'mail-smtp',
          mailDestinationTuple({ provider: 'smtp', smtp: config.smtp }),
          { env, envOverride },
        );
  if (!pass) return 'configuration_incomplete';
  const from = mailFromAddress(config);
  return {
    ...env,
    EMAIL_SERVICE_PROVIDER: 'nodemailer',
    SMTP_FROM: from,
    SMTP_HOST: config.smtp!.host,
    SMTP_PASS: pass,
    SMTP_PORT: String(config.smtp!.port),
    SMTP_SECURE: config.smtp!.secure ? 'true' : undefined,
    SMTP_USER: config.smtp!.user,
  };
}

async function envBagFromResendDraft(
  config: MailUpdate,
  env: EnvBag,
  envOverride: boolean,
): Promise<EnvBag | 'configuration_incomplete'> {
  const keyAction = config.resend?.apiKey ?? { action: 'keep' as const };
  if (keyAction.action === 'clear') return 'configuration_incomplete';
  const apiKey =
    keyAction.action === 'replace'
      ? keyAction.value
      : await resolveKeepSecret('mail-resend', mailDestinationTuple({ provider: 'resend' }), {
          env,
          envOverride,
        });
  if (!apiKey) return 'configuration_incomplete';
  const from = mailFromAddress(config);
  return {
    ...env,
    EMAIL_SERVICE_PROVIDER: 'resend',
    RESEND_API_KEY: apiKey,
    RESEND_FROM: from,
  };
}

export async function envBagFromDraft(
  dependency: 'mail' | 'objectStorage',
  draft: AdminSystemMailConfig | AdminSystemObjectStorageConfig,
  params: { env: EnvBag; envOverride: boolean },
): Promise<EnvBag | 'configuration_incomplete'> {
  if (dependency === 'objectStorage') {
    return envBagFromObjectStorageDraft(
      draft as ObjectStorageUpdate,
      params.env,
      params.envOverride,
    );
  }

  const config = draft as MailUpdate;
  if (config.provider === 'smtp') {
    return envBagFromSmtpDraft(config, params.env, params.envOverride);
  }
  return envBagFromResendDraft(config, params.env, params.envOverride);
}
