'use client';

import { getPluginMode, upsertPluginMode } from '@lobechat/types';
import isEqual from 'fast-deep-equal';
import { useCallback, useMemo } from 'react';

import {
  selectSkillRuntimeSources,
  usePublishedSkillCatalog,
} from '@/enterprise/client/features/skills';
import { useAgentStore } from '@/store/agent';
import { useToolStore } from '@/store/tool';
import { agentSkillsSelectors, builtinToolSelectors } from '@/store/tool/selectors';
import type { PlatformPublishedSkill } from '@/types/platform/skills';
import { getPlatformSkillToggleMode, resolvePlatformSkillSelection } from '@/types/platform/skills';

type PluginConfig = { plugins?: Parameters<typeof getPluginMode>[0] } | undefined;

type BuiltinSkill = ReturnType<typeof builtinToolSelectors.installedBuiltinSkills>[number];
type MarketSkill = ReturnType<typeof agentSkillsSelectors.getMarketAgentSkills>[number];
type UserSkill = ReturnType<typeof agentSkillsSelectors.getUserAgentSkills>[number];
type PlatformCatalog = ReturnType<typeof agentSkillsSelectors.getPlatformSkillCatalog>;

export interface UseManagedAgentSkillsResult {
  /** Arbitrated (display) lists — empty under managed ready/loading/error. */
  installedBuiltinSkills: BuiltinSkill[];
  marketAgentSkills: MarketSkill[];
  platformSkillCatalog: PlatformCatalog | null;
  platformSkillRuntimeManaged: boolean;
  platformSkillRuntimeStatus: string;
  /**
   * Raw store lists for identity bookkeeping (filter + auto-cleanup).
   * Must stay unarbitrated so managed mode does not leak builtins into the
   * dropdown or prune persisted market/user skill plugin ids.
   */
  rawBuiltinSkills: BuiltinSkill[];
  rawMarketSkills: MarketSkill[];
  rawPlatformCatalog: PlatformCatalog | null;
  rawUserSkills: UserSkill[];
  retryPlatformCatalog: () => void;
  togglePlatformSkill: (skill: PlatformPublishedSkill) => Promise<void>;
  useLegacySkills: boolean;
  userAgentSkills: UserSkill[];
}

/**
 * Managed (platform) skill catalog state + selection mutation for agent tool editors.
 * Isolates SWR lifecycle, source arbitration, and distribution policy from AgentTool.
 *
 * Returns both arbitrated lists (UI) and raw lists (identity bookkeeping).
 */
export const useManagedAgentSkills = (
  effectiveAgentId: string,
  config: PluginConfig,
  canEdit: boolean,
): UseManagedAgentSkillsResult => {
  const updateAgentConfigById = useAgentStore((s) => s.updateAgentConfigById);

  const rawInstalledBuiltinSkills = useToolStore(
    builtinToolSelectors.installedBuiltinSkills,
    isEqual,
  );
  const rawMarketAgentSkills = useToolStore(agentSkillsSelectors.getMarketAgentSkills, isEqual);
  const rawUserAgentSkills = useToolStore(agentSkillsSelectors.getUserAgentSkills, isEqual);
  const rawPlatformSkillCatalog = useToolStore(
    agentSkillsSelectors.getPlatformSkillCatalog,
    isEqual,
  );
  const platformSkillRuntimeManaged = useToolStore((state) =>
    Boolean(state.platformSkillRuntimeManaged),
  );
  const platformSkillRuntimeStatus = useToolStore(
    (state) => state.platformSkillRuntimeStatus ?? 'unmanaged',
  );
  const platformCatalogSWR = usePublishedSkillCatalog(platformSkillRuntimeManaged);

  const skillRuntimeSources = useMemo(
    () =>
      selectSkillRuntimeSources({
        builtin: rawInstalledBuiltinSkills,
        market: rawMarketAgentSkills,
        platform: rawPlatformSkillCatalog,
        status: platformSkillRuntimeStatus,
        user: rawUserAgentSkills,
      }),
    [
      platformSkillRuntimeStatus,
      rawInstalledBuiltinSkills,
      rawMarketAgentSkills,
      rawPlatformSkillCatalog,
      rawUserAgentSkills,
    ],
  );

  const togglePlatformSkill = useCallback(
    async (skill: PlatformPublishedSkill) => {
      if (!canEdit || !effectiveAgentId) return;
      const current = resolvePlatformSkillSelection(
        skill.distribution,
        getPluginMode(config?.plugins, skill.skillKey),
      );
      const nextMode = getPlatformSkillToggleMode(skill.distribution, !current.available);
      if (!nextMode) return;
      await updateAgentConfigById(effectiveAgentId, {
        plugins: upsertPluginMode(config?.plugins, skill.skillKey, nextMode),
      });
    },
    [canEdit, config?.plugins, effectiveAgentId, updateAgentConfigById],
  );

  // SWR returns a fresh response object every render; only `mutate` is stable.
  const mutateCatalog = platformCatalogSWR.mutate;
  const retryPlatformCatalog = useCallback(() => {
    void mutateCatalog();
  }, [mutateCatalog]);

  return useMemo(
    () => ({
      installedBuiltinSkills: skillRuntimeSources.builtin as BuiltinSkill[],
      marketAgentSkills: skillRuntimeSources.market as MarketSkill[],
      platformSkillCatalog: skillRuntimeSources.platform,
      platformSkillRuntimeManaged,
      platformSkillRuntimeStatus,
      rawBuiltinSkills: rawInstalledBuiltinSkills,
      rawMarketSkills: rawMarketAgentSkills,
      rawPlatformCatalog: rawPlatformSkillCatalog,
      rawUserSkills: rawUserAgentSkills,
      retryPlatformCatalog,
      togglePlatformSkill,
      useLegacySkills: platformSkillRuntimeStatus === 'unmanaged',
      userAgentSkills: skillRuntimeSources.user as UserSkill[],
    }),
    [
      platformSkillRuntimeManaged,
      platformSkillRuntimeStatus,
      rawInstalledBuiltinSkills,
      rawMarketAgentSkills,
      rawPlatformSkillCatalog,
      rawUserAgentSkills,
      retryPlatformCatalog,
      skillRuntimeSources,
      togglePlatformSkill,
    ],
  );
};
