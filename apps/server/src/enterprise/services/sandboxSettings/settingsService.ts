import { getServerDB } from '@/database/core/db-adaptor';
import { PlatformSandboxSettingsModel } from '@/database/models/platform/sandboxSettings';
import type { LobeChatDatabase, Transaction } from '@/database/type';
import type { AdminSystemGetSandboxSettings } from '@/server/enterprise/contracts/adminSystem';
import { isModuleEnabled } from '@/server/enterprise/services/moduleSettings';
import type { PlatformSandboxSettings } from '@/types/platform/sandboxSettings';
import { normalizeSandboxSettings } from '@/types/platform/sandboxSettings';

import type { EffectiveSandboxSettings, SandboxEnvBag } from './effective';
import { getEffectiveSandboxSettings, invalidateEffectiveSandboxSettings } from './effective';

export const SANDBOX_SETTINGS_AUDIT_ACTION = 'system.infra.sandbox.update';
export const SANDBOX_SETTINGS_AUDIT_TARGET_TYPE = 'infra_settings';

export interface SandboxSettingsView extends EffectiveSandboxSettings {
  enabled: boolean;
  moduleEnabled: boolean;
}

export const toSandboxSettingsOutput = (
  view: SandboxSettingsView,
): AdminSystemGetSandboxSettings => ({
  cpus: view.cpus,
  dockerHost: view.dockerHost ?? null,
  dockerSocket: view.dockerSocket,
  enabled: view.enabled,
  idleTtlSec: view.idleTtlSec,
  image: view.image,
  maxContainers: view.maxContainers,
  maxOutputBytes: view.maxOutputBytes,
  memoryMb: view.memoryMb,
  moduleEnabled: view.moduleEnabled,
  network: view.network,
  pidsLimit: view.pidsLimit,
  provider: view.provider,
  pullPolicy: view.pullPolicy,
  revision: view.revision,
  source: view.source,
  timeoutMs: view.timeoutMs,
});

export const getSandboxSettingsView = async (options?: {
  db?: ConstructorParameters<typeof PlatformSandboxSettingsModel>[0];
  env?: SandboxEnvBag;
}): Promise<SandboxSettingsView> => {
  const db = options?.db ?? (options?.env ? undefined : await getServerDB());
  const [effective, stored, moduleEnabled] = await Promise.all([
    getEffectiveSandboxSettings({ db, env: options?.env }),
    db
      ? new PlatformSandboxSettingsModel(db).get()
      : Promise.resolve({ ...normalizeSandboxSettings({}), revision: 0 }),
    isModuleEnabled('sandbox'),
  ]);

  return {
    ...effective,
    enabled: stored.enabled,
    moduleEnabled,
    revision: stored.revision,
  };
};

export const updateSandboxSettings = async (
  db: LobeChatDatabase | Transaction,
  input: { config: PlatformSandboxSettings; expectedRevision: number; updatedBy: string },
): Promise<SandboxSettingsView> => {
  const model = new PlatformSandboxSettingsModel(db);
  const row = await model.update(input.updatedBy, {
    ...normalizeSandboxSettings(input.config),
    expectedRevision: input.expectedRevision,
  });
  invalidateEffectiveSandboxSettings();
  const [effective, moduleEnabled] = await Promise.all([
    getEffectiveSandboxSettings({ db }),
    isModuleEnabled('sandbox'),
  ]);
  return {
    ...effective,
    enabled: row.enabled,
    moduleEnabled,
    revision: row.revision,
  };
};

/** Redacted audit afterDiff — sandbox settings contain no secrets. */
export const summarizeSandboxAfterDiff = (config: PlatformSandboxSettings) => ({
  cpus: config.cpus ?? null,
  dockerHost: config.dockerHost ?? null,
  dockerSocket: config.dockerSocket ?? null,
  enabled: config.enabled,
  idleTtlSec: config.idleTtlSec ?? null,
  image: config.image ?? null,
  maxContainers: config.maxContainers ?? null,
  maxOutputBytes: config.maxOutputBytes ?? null,
  memoryMb: config.memoryMb ?? null,
  network: config.network ?? null,
  pidsLimit: config.pidsLimit ?? null,
  provider: config.provider ?? null,
  pullPolicy: config.pullPolicy ?? null,
  timeoutMs: config.timeoutMs ?? null,
});
