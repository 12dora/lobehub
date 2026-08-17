import { emailEnv } from '@/envs/email';
import { fileEnv } from '@/envs/file';

import type { InfraEnvBag } from '../platformSystem/infraDependencyConfig';

/**
 * Process-env fallback bag for object storage / mail / key-management probes.
 * Extracted from `infraSettingsService.resolveEnv` so the resolver, snapshot,
 * and admin read path share one source.
 */
export const resolveInfraEnvBag = (override?: InfraEnvBag): InfraEnvBag => {
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
    S3_PREVIEW_URL_EXPIRE_IN: String(fileEnv.S3_PREVIEW_URL_EXPIRE_IN),
    S3_PUBLIC_DOMAIN: fileEnv.S3_PUBLIC_DOMAIN,
    S3_REGION: fileEnv.S3_REGION,
    S3_SECRET_ACCESS_KEY: fileEnv.S3_SECRET_ACCESS_KEY,
    S3_SET_ACL: fileEnv.S3_SET_ACL ? '1' : undefined,
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

export const envPreviewUrlExpireIn = (env: InfraEnvBag): number => {
  const raw = env.S3_PREVIEW_URL_EXPIRE_IN;
  if (!raw) return fileEnv.S3_PREVIEW_URL_EXPIRE_IN;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fileEnv.S3_PREVIEW_URL_EXPIRE_IN;
};
