import type { InstallMarketplaceAgentSummary } from '@lobechat/builtin-tool-web-onboarding/agentMarketplace';
import { customAlphabet } from 'nanoid/non-secure';

import { getActiveWorkspaceId } from '@/business/client/hooks/useActiveWorkspaceId';
import { lambdaClient } from '@/libs/trpc/client';
import { agentService } from '@/services/agent';
import { parseAgentTemplateId } from '@/services/agentMarketplace';
import { discoverService } from '@/services/discover';
import { marketApiService } from '@/services/marketApi';
import { useAgentStore } from '@/store/agent';
import { useHomeStore } from '@/store/home';

export type { InstallMarketplaceAgentSummary };

const generateMarketIdentifier = () => {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const generate = customAlphabet(alphabet, 8);
  return generate();
};

const getSourcePath = () => {
  if (typeof location === 'undefined') return 'onboarding/agent-marketplace';

  return location.pathname;
};

export interface InstallMarketplaceAgentsResult {
  /**
   * True only when this call freshly auto-provisioned the workspace's Market
   * Community profile (owner-only path). Lets the caller surface a "we set up
   * a community handle for you — customize it later" nudge once, instead of
   * silently mutating the workspace's public identity.
   */
  createdMarketProfile?: boolean;
  installedAgentIds: string[];
  skippedAgentIds: string[];
  summaries: InstallMarketplaceAgentSummary[];
}

export interface InstallMarketplaceAgentsOptions {
  /**
   * Override the visibility used when inserting into a workspace. Defaults to
   * `'public'` (shared with the workspace) — callers can opt into `'private'`
   * when the user explicitly wants the agent kept to themselves.
   *
   * Ignored in personal mode (the column is meaningless without a workspace).
   */
  visibility?: 'private' | 'public';
}

export const installMarketplaceAgents = async (
  sourceAgentIds: string[],
  options?: InstallMarketplaceAgentsOptions,
): Promise<InstallMarketplaceAgentsResult> => {
  if (sourceAgentIds.length === 0) {
    return { installedAgentIds: [], skippedAgentIds: [], summaries: [] };
  }

  const createAgent = useAgentStore.getState().createAgent;
  const refreshAgentList = useHomeStore.getState().refreshAgentList;

  const workspaceId = getActiveWorkspaceId();
  const visibility = workspaceId ? (options?.visibility ?? 'public') : undefined;

  const requestedSources = sourceAgentIds.map((templateId) => {
    const source = parseAgentTemplateId(templateId);
    return {
      ...source,
      forkedFromIdentifier: source.sourceType === 'legacy' ? templateId : source.sourceId,
      templateId,
    };
  });

  // 1. Parallel dedupe — find which source ids are already installed
  const existing = await Promise.all(
    requestedSources.map(({ forkedFromIdentifier }) =>
      agentService.getAgentByForkedFromIdentifier(forkedFromIdentifier),
    ),
  );
  const skippedAgentIds: string[] = [];
  const pendingSources: typeof requestedSources = [];
  requestedSources.forEach((source, index) => {
    if (existing[index]) skippedAgentIds.push(source.templateId);
    else pendingSources.push(source);
  });

  // 2. Resolve each template from its explicit source. Legacy ids are
  // namespaced by the fallback picker, so an identifier shared by both
  // catalogs can never accidentally bypass a Market fork.
  const detailResults = await Promise.allSettled(
    pendingSources.map(({ sourceId, sourceType }) =>
      discoverService.getAssistantDetail({
        identifier: sourceId,
        source: sourceType,
      }),
    ),
  );

  // 3. Prepare only items with valid detail.
  type Prepared = {
    detail: NonNullable<Awaited<ReturnType<typeof discoverService.getAssistantDetail>>>;
    forkedFromIdentifier: string;
    sourceId: string;
    sourceType: 'legacy' | 'new';
    templateId: string;
  };
  const prepared: Prepared[] = [];
  detailResults.forEach((result, index) => {
    const source = pendingSources[index];
    if (result.status !== 'fulfilled') {
      console.warn('Failed to fetch marketplace agent detail:', source.sourceId, result.reason);
      return;
    }
    const detail = result.value;
    if (!detail?.config) {
      console.warn('Marketplace agent config is missing:', source.sourceId);
      return;
    }
    prepared.push({
      detail: detail as Prepared['detail'],
      ...source,
    });
  });

  const marketPrepared = prepared.filter((item) => item.sourceType === 'new');

  // Workspace-mode Market forks must be attributed to the workspace's Market
  // organization. Legacy-index copies are local and do not need that account.
  let actAs: number | undefined;
  let createdMarketProfile = false;
  if (workspaceId && marketPrepared.length > 0) {
    const { marketAccountId, created } =
      await lambdaClient.workspace.ensureMarketOrganization.mutate({
        autoProvision: true,
      });
    actAs = marketAccountId;
    createdMarketProfile = created;
  }

  // 4. Fork authenticated Market templates in one batch. Public legacy
  // templates are copied directly into the local library below.
  const forkOutcomes =
    marketPrepared.length === 0
      ? []
      : await marketApiService.forkAgent(
          marketPrepared.map((item) => ({
            actAs,
            identifier: generateMarketIdentifier(),
            name: item.detail.title,
            sourceIdentifier: item.sourceId,
            status: 'published',
            visibility: 'public',
          })),
        );
  const forkOutcomeBySource = new Map(
    forkOutcomes.map((outcome) => [outcome.sourceIdentifier, outcome]),
  );

  // 5. Create the local agents. Legacy templates intentionally omit
  // marketIdentifier because no remote Market fork exists.
  const installResults = await Promise.allSettled(
    prepared.map(async ({ detail, forkedFromIdentifier, sourceId, sourceType, templateId }) => {
      const forkOutcome = forkOutcomeBySource.get(sourceId);
      if (sourceType === 'new' && !forkOutcome?.success) {
        throw new Error(forkOutcome?.error.message || 'Marketplace fork failed');
      }

      const result = await createAgent({
        config: {
          ...detail.config,
          avatar: detail.avatar,
          backgroundColor: detail.backgroundColor,
          description: detail.description,
          editorData: detail.editorData,
          ...(forkOutcome?.success
            ? { marketIdentifier: forkOutcome.data.agent.identifier }
            : undefined),
          params: {
            ...detail.config.params,
            forkedFromIdentifier,
          },
          tags: detail.tags,
          title: forkOutcome?.success ? forkOutcome.data.agent.name : detail.title,
        },
        visibility,
      });

      if (forkOutcome?.success) {
        discoverService.reportAgentEvent({
          event: 'add',
          identifier: forkOutcome.data.agent.identifier,
          source: getSourcePath(),
        });
      }

      return { agentId: result.agentId, sourceId, templateId };
    }),
  );

  // 6. Build summaries — preserve the original per-source ordering
  const installedByTemplate = new Map<string, string>();
  installResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      installedByTemplate.set(r.value.templateId, r.value.agentId);
    } else {
      console.warn('Failed to install marketplace agent:', prepared[i]?.sourceId, r.reason);
    }
  });

  const detailByTemplate = new Map<string, Prepared['detail']>();
  prepared.forEach((p) => detailByTemplate.set(p.templateId, p.detail));

  const summaries: InstallMarketplaceAgentSummary[] = sourceAgentIds.map((templateId) => {
    if (skippedAgentIds.includes(templateId)) {
      return { skipped: true, templateId };
    }
    const detail = detailByTemplate.get(templateId);
    return {
      avatar: detail?.avatar,
      category: detail?.category,
      description: detail?.description || detail?.summary,
      installedAgentId: installedByTemplate.get(templateId),
      skipped: false,
      templateId,
      title: detail?.title,
    };
  });

  const installedAgentIds = Array.from(installedByTemplate.values());

  if (installedAgentIds.length > 0) {
    await refreshAgentList();
  }

  return { createdMarketProfile, installedAgentIds, skippedAgentIds, summaries };
};
