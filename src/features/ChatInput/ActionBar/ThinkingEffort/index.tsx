'use client';

import { findEffortControl } from '@lobechat/model-runtime';
import { Center, Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { createStaticStyles, cx } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { CheckIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { effortLevelLabelKey } from '@/features/ServiceModel/effortLevelLabel';
import { usePermission } from '@/hooks/usePermission';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors, chatConfigByIdSelectors } from '@/store/agent/selectors';
import { aiModelSelectors, useAiInfraStore } from '@/store/aiInfra';

import { useAgentId } from '../../hooks/useAgentId';
import { useUpdateAgentConfig } from '../../hooks/useUpdateAgentConfig';
import { type ActionDropdownMenuItems } from '../components/ActionDropdown';
import ActionDropdown from '../components/ActionDropdown';
import { useActionBarContext } from '../context';
import { resolveCurrentEffortLevel } from './resolveEffortLevel';

const styles = createStaticStyles(({ css, cssVar }) => ({
  level: css`
    font-size: 12px;
    line-height: 1;
    color: ${cssVar.colorTextSecondary};
  `,
  trigger: css`
    cursor: pointer;
    border-radius: 24px;

    :hover {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  triggerDisabled: css`
    cursor: not-allowed;
    opacity: 0.5;

    :hover {
      background: transparent;
    }
  `,
}));

/**
 * Quick "thinking effort" selector, sitting next to the model selector.
 *
 * Renders nothing unless the active model declares a discrete-level effort
 * extend param (`findEffortControl`); writing goes to the same `chatConfig`
 * field as the corresponding slider under `ModelSwitchPanel/ControlsForm`.
 */
const ThinkingEffort = memo(() => {
  // Levels are named in the `setting` namespace so the pill, the service-model
  // picker and the ControlsForm sliders all read the same words.
  const { t } = useTranslation(['chat', 'setting']);
  const { actionSize, dropdownPlacement } = useActionBarContext();
  const blockSize = actionSize?.blockSize ?? 32;
  const { allowed: canCreateContent, reason } = usePermission('create_content');

  const agentId = useAgentId();
  const { updateAgentChatConfig } = useUpdateAgentConfig();
  const [model, provider] = useAgentStore((s) => [
    agentByIdSelectors.getAgentModelById(agentId)(s),
    agentByIdSelectors.getAgentModelProviderById(agentId)(s),
  ]);
  const chatConfig = useAgentStore(
    (s) => chatConfigByIdSelectors.getChatConfigById(agentId)(s),
    isEqual,
  );
  const extendParams = useAiInfraStore(aiModelSelectors.modelExtendParams(model, provider));
  const control = useMemo(() => findEffortControl(extendParams), [extendParams]);

  const currentLevel = control
    ? resolveCurrentEffortLevel({
        config: chatConfig,
        definition: control.definition,
        key: control.key,
        model,
      })
    : undefined;

  const items: ActionDropdownMenuItems = useMemo(() => {
    if (!control) return [];

    const { configKey, levels } = control.definition;

    return levels.map((level) => ({
      // The label is an element, which ActionDropdown otherwise reads as
      // "interactive content, keep the menu open". Picking a level is a
      // one-shot choice, so close on click like any other selector.
      closeOnClick: true,
      key: level,
      label: (
        <Flexbox horizontal align={'center'} gap={12} justify={'space-between'} width={'100%'}>
          <span>{t(effortLevelLabelKey(level), { ns: 'setting' })}</span>
          {level === currentLevel && <Icon icon={CheckIcon} size={14} />}
        </Flexbox>
      ),
      onClick: () => {
        if (level === currentLevel) return;
        updateAgentChatConfig({ [configKey]: level });
      },
    }));
  }, [control, currentLevel, t, updateAgentChatConfig]);

  if (!control || !currentLevel) return null;

  const currentLabel = t(effortLevelLabelKey(currentLevel), { ns: 'setting' });

  const trigger = (
    <Center
      horizontal
      aria-label={t('thinkingEffort.title', { ns: 'chat' })}
      className={cx(styles.trigger, !canCreateContent && styles.triggerDisabled)}
      height={blockSize}
      paddingInline={6}
    >
      <span className={styles.level}>{currentLabel}</span>
    </Center>
  );

  if (!canCreateContent)
    return (
      <Tooltip title={reason}>
        <div>{trigger}</div>
      </Tooltip>
    );

  return (
    <ActionDropdown menu={{ items }} minWidth={140} placement={dropdownPlacement ?? 'topLeft'}>
      <Tooltip title={t('thinkingEffort.tooltip', { level: currentLabel, ns: 'chat' })}>
        {trigger}
      </Tooltip>
    </ActionDropdown>
  );
});

ThinkingEffort.displayName = 'ThinkingEffort';

export default ThinkingEffort;
