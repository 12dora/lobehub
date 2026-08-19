import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import type { ConnectorOAuthRuntimeEnv } from './oauthRuntime';
import type { ConnectorRuntimeEffectiveMode } from './runtimeEffectiveState';
import { getConnectorRuntimeEffectiveState } from './runtimeEffectiveState';

/** Feature-off and non-enforced modes preserve legacy behavior without catalog runtime I/O. */
export const resolveConnectorRuntimeMode = async (params: {
  env?: ConnectorOAuthRuntimeEnv;
  resolveState?: () => Promise<{ mode: ConnectorRuntimeEffectiveMode; revision: number }>;
}): Promise<ConnectorRuntimeEffectiveMode> => {
  const env = params.env ?? process.env;
  const flags = parseEnterpriseFeatureFlags(env);
  if (!flags.ENABLE_PLATFORM_MANAGED_CONNECTORS) return 'legacy';
  return (await (params.resolveState ?? (() => getConnectorRuntimeEffectiveState(env)))()).mode;
};
