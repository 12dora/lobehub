'use client';

import { Tag, Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ModerationCategoryAction,
  ModerationEffectiveAction,
} from '@/const/platform/contentModeration';

import { EFFECTIVE_ACTION_TAG_COLOR, effectiveActionLabel, policyActionLabel } from '../format';

export interface ActionTagProps {
  effectiveAction: ModerationEffectiveAction;
  policyAction: ModerationCategoryAction;
}

/**
 * What actually happened, plus what *would* have happened. In observe mode the runtime always
 * allows, so without the second half the whole table would read "放行" and the dry run would be
 * invisible (design §6.2).
 */
const ActionTag = memo<ActionTagProps>(({ effectiveAction, policyAction }) => {
  const { t } = useTranslation('admin');
  const shadowed =
    effectiveAction === 'allow' && (policyAction === 'block' || policyAction === 'downgrade');

  return (
    <span style={{ alignItems: 'center', display: 'inline-flex', gap: 6 }}>
      <Tag color={EFFECTIVE_ACTION_TAG_COLOR[effectiveAction]} size="small">
        {effectiveActionLabel(t, effectiveAction)}
      </Tag>
      {shadowed ? (
        <Text style={{ fontSize: 12 }} type="secondary">
          {t('contentModeration.records.wouldBe', { action: policyActionLabel(t, policyAction) })}
        </Text>
      ) : null}
    </span>
  );
});

ActionTag.displayName = 'ModerationActionTag';

export default ActionTag;
