import type { AdminSystemInfraSettings } from '@/enterprise/client/services/adminSystem';
import type {
  AdminSystemInfraSecretAction,
  AdminSystemMailConfig,
  AdminSystemObjectStorageConfig,
} from '@/server/enterprise/contracts/adminSystem';

/**
 * Local aliases for the 基础设施 read/write contract, so the forms and the editor hook name the
 * shapes they work with without every file reaching into the server contract module.
 */
export type InfraSettingsSource = 'db' | 'env';

export type InfraSecretAction = AdminSystemInfraSecretAction;

export type InfraObjectStorageView = AdminSystemInfraSettings['objectStorage'];
export type InfraMailView = AdminSystemInfraSettings['mail'];

export type InfraObjectStorageConfigInput = AdminSystemObjectStorageConfig;
export type InfraMailConfigInput = AdminSystemMailConfig;
export type InfraSettingsConfigInput = InfraMailConfigInput | InfraObjectStorageConfigInput;
