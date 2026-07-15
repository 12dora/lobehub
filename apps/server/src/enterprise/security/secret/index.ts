export {
  CIPHERTEXT_PREFIX,
  DEFAULT_ENV_KEY_ID,
  ENVELOPE_ALG,
  ENVELOPE_VERSION,
  parsePlatformSecretConfig,
  PLATFORM_MASTER_KEY_ENV,
  PLATFORM_MASTER_KEY_ID_ENV,
  type PlatformSecretEnv,
  type PlatformSecretModuleConfig,
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
  VaultKeyProvider,
  type VaultKeyProviderOptions,
} from './keyProviders';
export {
  assertPlatformMasterKeyIfEnterprise,
  PlatformSecretService,
  type PlatformSecretServiceOptions,
} from './platformSecretService';
