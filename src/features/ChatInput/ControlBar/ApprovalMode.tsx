import { resolveTopicApprovalMode } from '@lobechat/types';
import { type MenuProps } from '@lobehub/ui';
import { Button, Center, DropdownMenu, Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { Check, ChevronDown, Hand, ListChecks, Zap } from 'lucide-react';
import { type LucideIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ManagedSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { isClientOnlyTopicId } from '@/store/chat/slices/topic/action';
import { useUserStore } from '@/store/user';
import { toolInterventionSelectors } from '@/store/user/selectors';
import {
  type ApprovalMode,
  type RawApprovalMode,
  USER_SELECTABLE_APPROVAL_MODES,
} from '@/store/user/slices/settings/selectors';

const styles = createStaticStyles(({ css, cssVar }) => ({
  desc: css`
    font-size: 12px;
    line-height: 1.4;
    color: ${cssVar.colorTextDescription};
  `,
  icon: css`
    border: 1px solid ${cssVar.colorFillTertiary};
    border-radius: ${cssVar.borderRadius};
    background: ${cssVar.colorBgElevated};
  `,
  modeButton: css`
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextSecondary};
  `,
  modeButtonDisabled: css`
    cursor: not-allowed;
    opacity: 0.5;
  `,
  title: css`
    font-size: 14px;
    font-weight: 500;
    line-height: 1.4;
    color: ${cssVar.colorText};
  `,
  trigger: css`
    overflow: hidden;
    border-radius: ${cssVar.borderRadius};
  `,
}));

const ModeItemLabel = memo<{ desc: string; icon: LucideIcon; title: string }>(
  ({ desc, icon, title }) => (
    <Flexbox horizontal align={'flex-start'} gap={12}>
      <Center className={styles.icon} flex={'none'} height={32} width={32}>
        <Icon icon={icon} />
      </Center>
      <Flexbox flex={1} style={{ minWidth: 120 }}>
        <div className={styles.title}>{title}</div>
        <div className={styles.desc}>{desc}</div>
      </Flexbox>
    </Flexbox>
  ),
);

const ModeSelector = memo(() => {
  const { t } = useTranslation('chat');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const { allowed: canCreateContent, reason } = usePermission('create_content');
  const rawApprovalMode = useUserStore(toolInterventionSelectors.rawApprovalMode);
  const userApprovalMode = useUserStore(toolInterventionSelectors.approvalMode);
  const updateHumanIntervention = useUserStore((s) => s.updateHumanIntervention);
  const activeTopicId = useChatStore((s) => s.activeTopicId);
  const topicApprovalMode = useChatStore(topicSelectors.currentTopicApprovalMode);
  const updateTopicApprovalMode = useChatStore((s) => s.updateTopicApprovalMode);
  const platformMeta = usePlatformSettingMeta('tool.humanIntervention.approvalMode');
  const platformLocked = platformMeta.locked;

  // The user-store value is already the server-resolved effective setting, so it
  // stands in for both the user preference and the locked / platform-default
  // layer of the shared resolve chain.
  const effectiveMode = resolveTopicApprovalMode({
    lockedValue: rawApprovalMode,
    platformLocked,
    topicApprovalMode,
    userApprovalMode: rawApprovalMode,
  });
  // `headless` has no menu entry — present it as auto-run, exactly as before.
  const approvalMode: ApprovalMode = effectiveMode === 'headless' ? 'auto-run' : effectiveMode;
  /** The selected mode belongs to this conversation and diverges from the user default. */
  const isTopicOverride =
    !platformLocked && !!topicApprovalMode && topicApprovalMode !== userApprovalMode;

  const modeLabels = useMemo(
    () => ({
      'allow-list': t('tool.intervention.mode.allowList'),
      'auto-run': t('tool.intervention.mode.autoRun'),
      'headless': t('tool.intervention.mode.headless'),
      'manual': t('tool.intervention.mode.manual'),
    }),
    [t],
  );
  const displayMode: RawApprovalMode =
    platformMeta.enabled && effectiveMode === 'headless' ? 'headless' : approvalMode;

  const handleModeChange = useCallback(
    async (mode: ApprovalMode) => {
      if (!canCreateContent || platformLocked) return;

      // Inside a conversation the switch is scoped to that conversation only;
      // from the empty / new-chat view there is no topic yet, so it updates the
      // user default (which the next topic snapshots at creation).
      // Menu clicks are fire-and-forget, so neither write may reject: the
      // optimistic label already rolls back on failure, which is the feedback.
      try {
        // `tmp_topic_*` is a client-only placeholder for an in-flight first send:
        // there is nothing to PATCH server-side yet, so fall back to the default.
        if (activeTopicId && !isClientOnlyTopicId(activeTopicId)) {
          await updateTopicApprovalMode(activeTopicId, mode);
          return;
        }

        await updateHumanIntervention({ approvalMode: mode });
      } catch (error) {
        console.error('[ApprovalMode] failed to update approval mode:', error);
      }
    },
    [
      activeTopicId,
      canCreateContent,
      platformLocked,
      updateHumanIntervention,
      updateTopicApprovalMode,
    ],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!canCreateContent || platformLocked) return;

      setDropdownOpen(nextOpen);
    },
    [canCreateContent, platformLocked],
  );

  const menuItems = useMemo<MenuProps['items']>(() => {
    const definitions: Record<ApprovalMode, { desc: string; icon: LucideIcon }> = {
      'allow-list': { desc: t('tool.intervention.mode.allowListDesc'), icon: ListChecks },
      'auto-run': { desc: t('tool.intervention.mode.autoRunDesc'), icon: Zap },
      'manual': { desc: t('tool.intervention.mode.manualDesc'), icon: Hand },
    };

    return USER_SELECTABLE_APPROVAL_MODES.map((mode) => ({
      extra: approvalMode === mode ? <Icon icon={Check} /> : undefined,
      key: mode,
      label: (
        <ModeItemLabel
          desc={definitions[mode].desc}
          icon={definitions[mode].icon}
          title={modeLabels[mode]}
        />
      ),
      onClick: () => handleModeChange(mode),
    }));
  }, [approvalMode, modeLabels, handleModeChange, t]);

  const button = (
    <Button
      className={styles.modeButton}
      color={'default'}
      disabled={!canCreateContent || platformLocked}
      icon={ChevronDown}
      iconPlacement="end"
      size="small"
      variant={'text'}
    >
      {modeLabels[displayMode]}
    </Button>
  );

  const selector =
    !canCreateContent || platformLocked ? (
      <Tooltip
        title={displayMode === 'headless' ? t('tool.intervention.mode.headlessDesc') : reason}
      >
        <div className={styles.modeButtonDisabled}>{button}</div>
      </Tooltip>
    ) : (
      <DropdownMenu
        items={menuItems}
        open={canCreateContent && !platformLocked && dropdownOpen}
        placement="bottomRight"
        onOpenChange={handleOpenChange}
      >
        <div className={styles.trigger}>
          {dropdownOpen ? (
            button
          ) : (
            <Tooltip
              title={
                isTopicOverride
                  ? t('tool.intervention.mode.topicOnly')
                  : t('tool.intervention.approvalMode')
              }
            >
              {button}
            </Tooltip>
          )}
        </div>
      </DropdownMenu>
    );

  if (platformMeta.hidden) return null;
  if (!platformMeta.enabled) return selector;

  return (
    <ManagedSettingFieldContent meta={platformMeta}>{() => selector}</ManagedSettingFieldContent>
  );
});

export default ModeSelector;
