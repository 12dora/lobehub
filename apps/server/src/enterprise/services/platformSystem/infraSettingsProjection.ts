import type { AdminSystemGetInfraSettings } from '@/server/enterprise/contracts/adminSystem';
import { resolveFileS3Config } from '@/server/modules/S3/resolveFileS3Config';

import type { InfraEnvBag } from './infraDependencyConfig';
import {
  mailHealth,
  maskAccessId,
  objectStorageHealth,
  resolveEmailConfig,
} from './infraDependencyConfig';

type EnvBag = InfraEnvBag;

export interface InfraSettingsProjectionExtras {
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
}

function projectMailProvider(
  email: ReturnType<typeof resolveEmailConfig>,
): AdminSystemGetInfraSettings['mail']['provider'] {
  if (email.kind === 'resend' || (email.kind === 'incomplete' && email.provider === 'resend')) {
    return 'resend';
  }
  if (email.kind === 'unconfigured') return 'unconfigured';
  return 'smtp';
}

function projectMailFromEnv(
  env: EnvBag,
  extras: InfraSettingsProjectionExtras['mail'],
): AdminSystemGetInfraSettings['mail'] {
  const mail = mailHealth(env);
  const email = resolveEmailConfig(env);

  return {
    enabled: extras.enabled,
    errorCategory: mail.errorCategory,
    fromAddress: email.kind === 'smtp' || email.kind === 'resend' ? email.from : null,
    hasResendApiKey: extras.hasResendApiKey,
    hasSmtpPass: extras.hasSmtpPass,
    host: email.kind === 'smtp' ? email.host : null,
    port: email.kind === 'smtp' ? email.port : null,
    provider: projectMailProvider(email),
    revision: extras.revision,
    secure: email.kind === 'smtp' ? email.secure : null,
    senderName: email.kind === 'smtp' || email.kind === 'resend' ? email.senderName : null,
    smtpUser: extras.smtpUser,
    source: extras.source,
    status: mail.status,
  };
}

function projectObjectStorageFromEnv(
  env: EnvBag,
  extras: InfraSettingsProjectionExtras['objectStorage'],
): AdminSystemGetInfraSettings['objectStorage'] {
  const objectStorage = objectStorageHealth(env);
  const s3 = resolveFileS3Config(env);
  const rawAccessId =
    s3.kind === 'complete' ? s3.accessKeyId : env.S3_ACCESS_KEY_ID?.trim() || undefined;

  return {
    accessId: extras.accessIdMode === 'full' ? (rawAccessId ?? null) : maskAccessId(rawAccessId),
    bucket: s3.kind === 'complete' ? s3.bucket : env.S3_BUCKET?.trim() || null,
    enabled: extras.enabled,
    endpoint: s3.kind === 'complete' ? s3.endpoint : env.S3_ENDPOINT?.trim() || null,
    errorCategory: objectStorage.errorCategory,
    hasSecretAccessKey: extras.hasSecretAccessKey,
    pathStyle: s3.kind === 'complete' ? s3.forcePathStyle : env.S3_ENABLE_PATH_STYLE === '1',
    previewUrlExpireIn: extras.previewUrlExpireIn,
    publicDomain:
      s3.kind === 'complete' ? (s3.publicDomain ?? null) : env.S3_PUBLIC_DOMAIN?.trim() || null,
    region: s3.kind === 'complete' ? s3.region : env.S3_REGION?.trim() || null,
    revision: extras.revision,
    setAcl: extras.setAcl,
    source: extras.source,
    status: objectStorage.status,
  };
}

export function projectInfraSettingsFromEnv(
  env: EnvBag,
  extras: InfraSettingsProjectionExtras,
  snapshotAt: Date,
): AdminSystemGetInfraSettings {
  return {
    mail: projectMailFromEnv(env, extras.mail),
    objectStorage: projectObjectStorageFromEnv(env, extras.objectStorage),
    snapshotAt,
  };
}
