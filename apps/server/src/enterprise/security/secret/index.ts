export {
  CIPHERTEXT_PREFIX,
  DEFAULT_ENV_KEY_ID,
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  parsePlatformKeyProviderName,
  parsePlatformSecretConfig,
  PLATFORM_KEY_PROVIDER_ENV,
  PLATFORM_MASTER_KEY_ENV,
  PLATFORM_MASTER_KEY_ID_ENV,
  type PlatformKeyProviderName,
  type PlatformSecretEnv,
  type PlatformSecretModuleConfig,
  VAULT_ADDR_ENV,
  VAULT_APPROLE_MOUNT_PATH_ENV,
  VAULT_APPROLE_ROLE_ID_ENV,
  VAULT_APPROLE_SECRET_ID_ENV,
  VAULT_KV_MOUNT_PATH_ENV,
  VAULT_KV_SECRET_PATH_ENV,
  VAULT_TOKEN_ENV,
} from './config';
export {
  type EnvelopeV1,
  getEnvelopeKeyId,
  openEnvelope,
  parseEnvelopeString,
  sealEnvelope,
} from './envelope';
export {
  PlatformSecretError,
  secretInvalidInput,
  secretMasterKeyMissing,
  secretNotReadable,
} from './errors';
export {
  EnvKeyProvider,
  type EnvKeyProviderOptions,
  type KekMaterial,
  type KeyProvider,
  type VaultAppRoleAuth,
  type VaultAppRoleSecretIdProvider,
  type VaultAuth,
  VaultKeyProvider,
  type VaultKeyProviderOptions,
  type VaultTokenAuth,
} from './keyProviders';
export {
  assertPlatformMasterKeyIfEnterprise,
  PlatformSecretService,
  type PlatformSecretServiceOptions,
  warnIfPlatformMasterKeyMissing,
} from './platformSecretService';
