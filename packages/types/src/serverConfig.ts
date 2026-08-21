import type { PartialDeep } from 'type-fest';

import type { IFeatureFlagsState } from '@/config/featureFlags';

import type { ChatModelCard } from './llm';
import type {
  GlobalLLMProviderKey,
  UserDefaultAgent,
  UserImageConfig,
  UserServiceModelConfig,
} from './user/settings';

export type GlobalMemoryLayer = 'activity' | 'context' | 'experience' | 'identity' | 'preference';

export interface MemoryAgentPublicConfig {
  baseURL?: string;
  contextLimit?: number;
  model?: string;
  provider?: string;
}

export interface MemoryLayerExtractorPublicConfig extends MemoryAgentPublicConfig {
  layers?: Partial<Record<GlobalMemoryLayer, string>>;
}

export interface GlobalMemoryExtractionConfig {
  agentGateKeeper: MemoryAgentPublicConfig;
  agentLayerExtractor: MemoryLayerExtractorPublicConfig;
  concurrency?: number;
  embedding?: MemoryAgentPublicConfig;
}

export interface GlobalMemoryConfig {
  userMemory?: GlobalMemoryExtractionConfig;
}

export interface VisualUnderstandingConfig {
  model: string;
  provider: string;
}

export interface ServerModelProviderConfig {
  enabled?: boolean;
  enabledModels?: string[];
  fetchOnClient?: boolean;
  /**
   * the model lists defined in server
   */
  serverModelLists?: ChatModelCard[];
}

export type ServerLanguageModel = Partial<Record<GlobalLLMProviderKey, ServerModelProviderConfig>>;

/**
 * Minimal enterprise surface on Global Config (M00 mount point #4).
 * Clients must not call platform.* when `enabled` is false/undefined.
 * Does not expose flag names, roles, permissions, or secrets.
 */
export interface EnterprisePublicServerConfig {
  /**
   * True when any enterprise feature flag is on.
   * Gates EnterprisePlatformProvider network calls after config.getGlobalConfig.
   */
  enabled: boolean;
  /**
   * Effective on/off map of platform modules (`LOBE_MODULES_DISABLED` + DB).
   * Injected into `window.__SERVER_CONFIG__.config.enterprise.modules`.
   */
  modules?: Record<string, boolean>;
  /**
   * True when the platform admin shell feature is enabled (ENABLE_PLATFORM_ADMIN).
   * Feature existence only — never authorization. Gates whether `/admin` may mount;
   * real access still requires `admin.auth.getMyAccess` + server RBAC.
   */
  platformAdmin?: boolean;
}

export interface GlobalServerConfig {
  /**
   * Agent Gateway URL for WebSocket-based agent execution.
   * When set, the SPA can offload agent execution to the server and receive
   * events via the Gateway instead of running the agent loop client-side.
   */
  agentGatewayUrl?: string;
  aiProvider: ServerLanguageModel;
  defaultAgent?: PartialDeep<UserDefaultAgent>;
  disableEmailPassword?: boolean;
  enableBusinessFeatures?: boolean;
  enableComposio?: boolean;
  /**
   * @deprecated
   */
  enabledOAuthSSO?: boolean;
  enableEmailVerification?: boolean;
  /**
   * Whether Gateway mode is available for app-level agent execution.
   */
  enableGatewayMode?: boolean;
  enableLobehubSkill?: boolean;
  enableMagicLink?: boolean;
  enableMarketTrustedClient?: boolean;
  enableUploadFileToServer?: boolean;
  enableVisualUnderstanding?: boolean;
  /**
   * AIHub enterprise gate (M00). Omitted or `{ enabled: false }` when all flags are off.
   */
  enterprise?: EnterprisePublicServerConfig;
  image?: PartialDeep<UserImageConfig>;
  memory?: GlobalMemoryConfig;
  /** Secret-free provider presentation metadata in server-authoritative login order. */
  oAuthSSOProviderMetadata?: Array<{
    icon: string | null;
    id: string;
    label: string | null;
    order: number;
    providerKey: string;
  }>;
  oAuthSSOProviders?: string[];
  /**
   * Server-side Cloud Sandbox backend. Clients use this to skip Market OIDC
   * prompts when execution is local Docker or Onlyboxes rather than LobeHub Market.
   */
  sandboxProvider?: 'local' | 'market' | 'onlyboxes';
  systemAgent?: PartialDeep<UserServiceModelConfig>;
  telemetry: {
    langfuse?: boolean;
  };
  visualUnderstanding?: VisualUnderstandingConfig;
}

export interface GlobalBillboardItemLocaleFields {
  description?: string;
  linkLabel?: string;
  title?: string;
}

export interface GlobalBillboardItem {
  cover?: string | null;
  description: string;
  /**
   * Override copy per locale. Falls back to the default fields when the locale or a field within it is missing.
   */
  i18n?: Record<string, GlobalBillboardItemLocaleFields>;
  id: number;
  linkLabel?: string | null;
  linkUrl?: string | null;
  title: string;
}

export interface GlobalBillboardLocaleFields {
  title?: string;
}

export interface GlobalBillboard {
  endAt: string;
  /**
   * Override billboard-level fields per locale (currently only title). Falls back to the default title when missing.
   */
  i18n?: Record<string, GlobalBillboardLocaleFields>;
  id: number;
  items: GlobalBillboardItem[];
  slug: string;
  startAt: string;
  title: string;
}

export interface GlobalRuntimeConfig {
  billboard?: GlobalBillboard | null;
  serverConfig: GlobalServerConfig;
  serverFeatureFlags: IFeatureFlagsState;
}
