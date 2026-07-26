'use client';

import { getPluginMode } from '@lobechat/types';
import { Flexbox, Icon, type ItemType } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import ToolItem from '@/features/ChatInput/ActionBar/Tools/ToolItem';
import ToolItemDetailPopover from '@/features/ChatInput/ActionBar/Tools/ToolItemDetailPopover';
import { ManagedSkillRetryButton } from '@/features/ManagedSkills/ManagedSkillRetryButton';
import { resolvePlatformSkillSelection } from '@/types/platform/skills';

import { runAgentToolUpdate } from './runAgentToolUpdate';
import type { UseManagedAgentSkillsResult } from './useManagedAgentSkills';

const SKILL_ICON_SIZE = 20;

export interface ManagedSkillToolItemsProps {
  canEdit: boolean;
  config: { plugins?: Parameters<typeof getPluginMode>[0] } | undefined;
  managed: UseManagedAgentSkillsResult;
  setUpdating: (updating: boolean) => void;
}

export interface ManagedSkillMenuSections {
  /** Platform catalog rows when managed+ready; empty when using legacy builtins. */
  platformSkillItems: ItemType[];
  platformSkillUnavailableItems: ItemType[];
  /** True when builtin section should render platform catalog instead of legacy builtins. */
  usePlatformCatalog: boolean;
}

/**
 * Presentation builder for managed platform skills in the agent tool dropdown.
 * Keeps distribution badges, mandatory locks, and runtime-unavailable retry out of AgentTool.
 */
export const useManagedSkillMenuSections = ({
  canEdit,
  config,
  managed,
  setUpdating,
}: ManagedSkillToolItemsProps): ManagedSkillMenuSections => {
  const { t } = useTranslation('setting');
  const {
    platformSkillCatalog,
    platformSkillRuntimeManaged,
    platformSkillRuntimeStatus,
    retryPlatformCatalog,
    togglePlatformSkill,
  } = managed;

  const platformSkillItems = useMemo(
    () =>
      (platformSkillCatalog?.skills ?? []).map((skill) => ({
        icon: <Icon icon={SkillsIcon} size={SKILL_ICON_SIZE} />,
        key: skill.skillKey,
        label: (
          <ToolItem
            disabled={skill.distribution === 'mandatory' || !canEdit}
            id={skill.skillKey}
            label={skill.displayName}
            checked={
              resolvePlatformSkillSelection(
                skill.distribution,
                getPluginMode(config?.plugins, skill.skillKey),
              ).available
            }
            onUpdate={async () => {
              try {
                await runAgentToolUpdate(setUpdating, () => togglePlatformSkill(skill));
              } catch {
                // runAgentToolUpdate clears its spinner in finally then rethrows;
                // surface a localized error so the checkbox does not appear stuck.
                toast.error(t('platformSkills.detail.saveFailed'));
              }
            }}
          />
        ),
        popoverContent: (
          <ToolItemDetailPopover
            description={skill.description ?? ''}
            icon={<Icon icon={SkillsIcon} size={36} />}
            identifier={skill.skillKey}
            sourceLabel={t(`platformSkills.source.${skill.source}` as never)}
            title={skill.displayName}
          />
        ),
      })),
    [canEdit, config?.plugins, platformSkillCatalog, setUpdating, t, togglePlatformSkill],
  );

  const platformSkillUnavailableItems = useMemo<ItemType[]>(() => {
    if (!platformSkillRuntimeManaged || platformSkillRuntimeStatus === 'ready') return [];
    const loading = platformSkillRuntimeStatus === 'loading';
    return [
      {
        disabled: loading,
        key: 'platform-skill-runtime-unavailable',
        label: (
          <Flexbox horizontal align="center" gap={8} justify="space-between">
            <span>
              {t(loading ? 'platformSkills.runtime.loading' : 'platformSkills.runtime.unavailable')}
            </span>
            <ManagedSkillRetryButton disabled={loading} onRetry={retryPlatformCatalog} />
          </Flexbox>
        ),
      },
    ];
  }, [platformSkillRuntimeManaged, platformSkillRuntimeStatus, retryPlatformCatalog, t]);

  return {
    platformSkillItems,
    platformSkillUnavailableItems,
    usePlatformCatalog: Boolean(platformSkillCatalog),
  };
};
