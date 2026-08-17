/**
 * Admin-editable infrastructure settings (object storage + mail).
 * Design: docs/enterprise/infra-settings.md.
 */

export const INFRA_SETTINGS_IDS = ['object_storage', 'mail'] as const;
export type InfraSettingsId = (typeof INFRA_SETTINGS_IDS)[number];

export const INFRA_SETTINGS_ID_OBJECT_STORAGE = 'object_storage' satisfies InfraSettingsId;
export const INFRA_SETTINGS_ID_MAIL = 'mail' satisfies InfraSettingsId;

/** `PlatformConfigInvalidationEvent.scopes` entry used to fan out effective S3 / mail bags. */
export const INFRA_SETTINGS_INVALIDATION_SCOPE = 'infra_settings';

export const INFRA_SETTINGS_LIMITS = {
  ACCESS_KEY_ID_MAX: 128,
  BUCKET_MAX: 255,
  ENDPOINT_MAX: 2048,
  FROM_ADDRESS_MAX: 320,
  PREVIEW_URL_EXPIRE_MAX: 604_800,
  PREVIEW_URL_EXPIRE_MIN: 60,
  PUBLIC_DOMAIN_MAX: 2048,
  REGION_MAX: 64,
  RESEND_API_KEY_MAX: 512,
  SECRET_ACCESS_KEY_MAX: 512,
  SENDER_NAME_MAX: 256,
  /** DomainConfigCache TTL for the decrypted effective bag. */
  SNAPSHOT_TTL_MS: 30_000,
  SMTP_HOST_MAX: 255,
  SMTP_PASS_MAX: 512,
  SMTP_USER_MAX: 320,
} as const;

export const INFRA_SETTINGS_DEFAULT_PREVIEW_URL_EXPIRE_IN = 7200;
