import { INBOX_SESSION_ID } from '@lobechat/const';
import {
  type AgentItem,
  type LobeAgentConfig,
  PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
} from '@lobechat/types';

import type { EnterpriseFeatureFlags } from '@/const/platform/featureFlags';
import type { PlatformManagedResourcePolicyModel } from '@/database/models/platform';
import type { PlatformAgentCatalogRepository } from '@/database/repositories/platformAgentCatalog';
import type { LobeChatDatabase } from '@/database/type';
import type { AgentConfigWithId } from '@/server/services/agent';

import { parseEnterpriseFeatureFlags } from '../../featureFlags';
import { validateExactPlatformAgentDependencies } from './dependencyValidator';
import {
  PlatformAgentEffectiveResolver,
  type PlatformAgentOperationHandle,
} from './effectiveResolver';
import { PlatformAgentMaterializationService } from './materialization';

interface PlatformDefaultInboxServiceOptions {
  flags?: EnterpriseFeatureFlags;
  materializationService?: Pick<PlatformAgentMaterializationService, 'resolveForExistingAgent'>;
  policyModel?: Pick<PlatformManagedResourcePolicyModel, 'getSnapshot'>;
  repository?: PlatformAgentCatalogRepository;
  resolver?: Pick<PlatformAgentEffectiveResolver, 'beginSystemOperation'>;
  validateDependencies?: typeof validateExactPlatformAgentDependencies;
}

type BuiltinInboxConfig = AgentConfigWithId & Pick<AgentItem, 'description' | 'slug' | 'tags'>;

/**
 * Narrow adapter that maps the stable `default-inbox` platform role onto the existing builtin
 * `inbox` identity. It never creates/replaces an inbox row and never rewrites history.
 */
export class PlatformDefaultInboxService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly options: PlatformDefaultInboxServiceOptions = {},
  ) {}

  private flags = (): EnterpriseFeatureFlags =>
    this.options.flags ?? parseEnterpriseFeatureFlags(process.env);

  /** Flag-off short-circuits before policy/catalog IO. Null means genuinely not managed. */
  async capture(): Promise<PlatformAgentOperationHandle | null> {
    if (!this.flags().ENABLE_PLATFORM_MANAGED_AGENTS) return null;
    const resolver =
      this.options.resolver ??
      new PlatformAgentEffectiveResolver(this.db, {
        flags: this.options.flags,
        policyModel: this.options.policyModel,
        repository: this.options.repository,
      });
    return resolver.beginSystemOperation(this.userId, PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY);
  }

  /**
   * Overlay only the fields owned by the immutable platform version. Internal id/slug and the
   * existing non-managed chat/TTS/agency fields remain intact. Resolver/exact-version/dependency
   * errors propagate (never masquerade as "no default"); only a real null capture falls back.
   */
  getEffectiveBuiltinConfig = async (base: BuiltinInboxConfig): Promise<BuiltinInboxConfig> => {
    if (base.slug !== INBOX_SESSION_ID) return base;
    const handle = await this.capture();
    if (!handle) return base;
    const snapshot = handle.getSnapshot();
    const materialization =
      this.options.materializationService ??
      new PlatformAgentMaterializationService(this.db, this.userId, this.options.repository);
    const resolved = await materialization.resolveForExistingAgent(snapshot, base.id);
    await (this.options.validateDependencies ?? validateExactPlatformAgentDependencies)(
      this.db,
      resolved.dependencySnapshot,
    );

    const dependencyPluginIds = [
      ...resolved.dependencySnapshot.skills.map(({ skillKey }) => skillKey),
      ...resolved.dependencySnapshot.connectors.map(({ connectorKey }) => connectorKey),
    ];
    const plugins = [...new Set([...(snapshot.config.plugins ?? []), ...dependencyPluginIds])];

    return {
      ...base,
      avatar: snapshot.config.avatar ?? base.avatar,
      backgroundColor: snapshot.config.backgroundColor ?? undefined,
      description: snapshot.config.description ?? undefined,
      model: resolved.config.model,
      openingMessage: snapshot.config.openingMessage ?? undefined,
      openingQuestions: snapshot.config.openingQuestions,
      params: { ...base.params, ...resolved.config.params },
      platform: {
        ...resolved.config.platform!,
        systemKey: PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY,
      },
      plugins,
      provider: resolved.config.provider,
      slug: INBOX_SESSION_ID,
      systemRole: snapshot.config.systemRole,
      tags: snapshot.config.tags,
      title: snapshot.config.displayName,
    };
  };
}

/** Client/store helper: platform-managed state is carried by the effective config itself. */
export const isPlatformManagedInboxConfig = (
  config: Pick<LobeAgentConfig, 'platform'> | null | undefined,
): boolean =>
  config?.platform?.managed === true &&
  config.platform.systemKey === PLATFORM_AGENT_DEFAULT_INBOX_SYSTEM_KEY;
