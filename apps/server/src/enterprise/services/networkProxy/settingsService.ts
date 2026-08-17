import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import { NETWORK_PROXY_ENV, parseEgressScopeId } from '@/const/platform/networkProxy';
import { NetworkProxySettingsModel } from '@/database/models/platform/networkProxySettings';
import type { LobeChatDatabase } from '@/database/type';
import type {
  DesiredArtifacts,
  EgressScopeOp,
  NetworkProxyConfig,
  NetworkProxyConfigView,
  StaticProxyPersisted,
  StaticProxyUpdate,
} from '@/types/platform/networkProxy';
import {
  createDefaultEgressScopeState,
  normalizeNetworkProxyConfig,
} from '@/types/platform/networkProxy';

import { throwEnterpriseError } from '../../guards/enterpriseErrors';
import { sealNetworkProxySecret } from './secrets';

export interface NetworkProxySettingsRow {
  config: NetworkProxyConfig;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  revision: number;
  updatedAt: Date | null;
}

const toServiceRow = (row: {
  config: NetworkProxyConfig;
  desiredArtifacts: DesiredArtifacts;
  engineGeneration: number;
  revision: number;
  updatedAt: Date | null;
}): NetworkProxySettingsRow => ({
  config: normalizeNetworkProxyConfig(row.config),
  desiredArtifacts: row.desiredArtifacts,
  engineGeneration: row.engineGeneration,
  revision: row.revision,
  updatedAt: row.updatedAt,
});

export const getNetworkProxySettings = async (
  db: LobeChatDatabase,
): Promise<NetworkProxySettingsRow> => {
  const row = await new NetworkProxySettingsModel(db).ensureDefault();
  return toServiceRow(row);
};

export const updateNetworkProxySettings = async (
  db: LobeChatDatabase,
  input: { config: NetworkProxyConfig; expectedRevision: number; updatedBy: string },
): Promise<NetworkProxySettingsRow> => {
  const config = normalizeNetworkProxyConfig(input.config);
  const model = new NetworkProxySettingsModel(db);
  const current = await model.ensureDefault();
  assertCanEnable(config);
  assertSmartModeGeodata(config, current.desiredArtifacts, {
    currentRuleMode: current.config.ruleMode,
    // Generic settings writes (selectNode / updateScopes) carry ruleMode
    // through; they do not elect smart mode.
    ruleModeTouched: false,
  });
  const row = await model.update({
    config,
    expectedRevision: input.expectedRevision,
    updatedBy: input.updatedBy,
  });
  return toServiceRow(row);
};

/** Pure. Applies each scope op in order onto a cloned config. */
export const applyScopeOps = (
  config: NetworkProxyConfig,
  ops: EgressScopeOp[],
): NetworkProxyConfig => {
  const next = structuredClone(config);

  const mergeState = (
    current: { enabled: boolean; onUnavailable: 'direct' | 'fail' } | undefined,
    op: { enabled?: boolean; onUnavailable?: 'direct' | 'fail' },
  ) => {
    const base = current ?? createDefaultEgressScopeState();
    return {
      enabled: op.enabled ?? base.enabled,
      onUnavailable: op.onUnavailable ?? base.onUnavailable,
    };
  };

  for (const op of ops) {
    if (op.target === 'one') {
      const parsed = parseEgressScopeId(op.scope);
      if (!parsed) continue;
      if (parsed.kind === 'provider') {
        next.scopes.providers[parsed.id] = mergeState(next.scopes.providers[parsed.id], op);
      } else {
        next.scopes.features[parsed.id] = mergeState(next.scopes.features[parsed.id], op);
      }
      continue;
    }
    if (op.target === 'all_providers') {
      for (const id of op.providerIds) {
        next.scopes.providers[id] = mergeState(next.scopes.providers[id], op);
      }
      continue;
    }
    for (const key of Object.keys(next.scopes.features) as Array<
      keyof typeof next.scopes.features
    >) {
      next.scopes.features[key] = mergeState(next.scopes.features[key], op);
    }
  }

  return next;
};

export const applyStaticProxyUpdate = async (
  current: StaticProxyPersisted | undefined,
  update: StaticProxyUpdate | null,
): Promise<StaticProxyPersisted | undefined> => {
  if (update === null) return undefined;

  let passwordCiphertext = current?.passwordCiphertext;
  if (update.password.action === 'clear') {
    passwordCiphertext = undefined;
  } else if (update.password.action === 'replace') {
    passwordCiphertext = await sealNetworkProxySecret(update.password.value);
  }

  const next: StaticProxyPersisted = {
    port: update.port,
    server: update.server,
    type: update.type,
  };
  if (update.username) next.username = update.username;
  if (passwordCiphertext) next.passwordCiphertext = passwordCiphertext;
  return next;
};

export const toNetworkProxyConfigView = (config: NetworkProxyConfig): NetworkProxyConfigView => {
  const { staticProxy, ...rest } = config;
  if (!staticProxy) return rest;
  return {
    ...rest,
    staticProxy: {
      hasPassword: Boolean(staticProxy.passwordCiphertext),
      port: staticProxy.port,
      server: staticProxy.server,
      type: staticProxy.type,
      ...(staticProxy.username ? { username: staticProxy.username } : {}),
    },
  };
};

/** `PROXY_URL` (legacy proxychains launcher) is set and non-empty. */
export const isLegacyGlobalProxyActive = (): boolean => {
  const value = process.env[NETWORK_PROXY_ENV.LEGACY_GLOBAL_PROXY];
  return typeof value === 'string' && value.trim().length > 0;
};

export const assertCanEnable = (config: NetworkProxyConfig): void => {
  if (config.masterEnabled && isLegacyGlobalProxyActive()) {
    throwEnterpriseError({
      code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GLOBAL_PROXY_ACTIVE,
      message:
        'A process-wide PROXY_URL is already active; disable it before enabling network proxy.',
    });
  }
};

/**
 * Smart routing needs both geoip and geosite requested (desired), not necessarily
 * installed on this instance yet — other nodes converge from desired state.
 *
 * Only enforced when the write *enters* smart mode, or when the caller payload
 * explicitly includes `ruleMode`. Already-smart rows stay writable for unrelated
 * fields (selectNode / updateScopes) so a pre-upgrade row is not frozen.
 */
export const assertSmartModeGeodata = (
  next: Pick<NetworkProxyConfig, 'ruleMode'>,
  desiredArtifacts: DesiredArtifacts,
  options: {
    currentRuleMode: NetworkProxyConfig['ruleMode'];
    ruleModeTouched: boolean;
  },
): void => {
  if (next.ruleMode !== 'smart') return;
  const enteringSmart = options.currentRuleMode !== 'smart';
  if (!enteringSmart && !options.ruleModeTouched) return;
  if (desiredArtifacts.geoip && desiredArtifacts.geosite) return;
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_NETWORK_PROXY_GEODATA_MISSING,
    message: 'Install the smart-routing rule data before enabling smart routing.',
  });
};
