'use client';

import { Text, Tooltip } from '@lobehub/ui';
import { Button, InputNumber, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  type ModerationCategoryAction,
} from '@/const/platform/contentModeration';

import { categoryLabel, policyActionLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import { defaultCategoryPolicies, type ModerationConfigView } from '../draft';
import SettingsSection from '../SettingsSection';

export interface CategoriesSectionProps {
  config: ModerationConfigView;
  disabled: boolean;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

/**
 * 类别与动作 (design §6.3.4). Ten fixed rows — the category set is a platform constant, so
 * the table is a policy editor, not a list you can grow.
 */
const CategoriesSection = memo<CategoriesSectionProps>(({ config, disabled, onPatch }) => {
  const { t } = useTranslation('admin');

  return (
    <SettingsSection
      description={t('contentModeration.settings.categories.desc')}
      title={t('contentModeration.settings.categories.title')}
      actions={
        <Button
          disabled={disabled}
          size="small"
          onClick={() => onPatch({ categories: defaultCategoryPolicies() })}
        >
          {t('contentModeration.settings.categories.restoreDefaults')}
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {MODERATION_CATEGORIES.map((category) => {
          const policy = config.categories[category];
          return (
            <div
              data-testid={`moderation-category-row-${category}`}
              key={category}
              style={{ alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: 12 }}
            >
              <Tooltip title={t(`contentModeration.categoryHint.${category}` as never)}>
                <Text style={{ margin: 0, minWidth: 140 }}>{categoryLabel(t, category)}</Text>
              </Tooltip>
              <Select
                disabled={disabled}
                style={{ width: 160 }}
                value={policy?.action}
                options={MODERATION_CATEGORY_ACTIONS.map((value) => ({
                  label: policyActionLabel(t, value),
                  value,
                }))}
                onChange={(next) =>
                  onPatch({
                    categories: {
                      ...config.categories,
                      [category]: {
                        action: (next as ModerationCategoryAction) ?? 'ignore',
                        threshold: policy?.threshold ?? 0.9,
                      },
                    },
                  })
                }
              />
              <InputNumber
                aria-label={t('contentModeration.settings.categories.threshold')}
                disabled={disabled}
                max={1}
                min={0}
                step={0.05}
                style={{ width: 120 }}
                value={policy?.threshold}
                onChange={(next) =>
                  onPatch({
                    categories: {
                      ...config.categories,
                      [category]: {
                        action: policy?.action ?? 'ignore',
                        threshold: Number(next ?? 0),
                      },
                    },
                  })
                }
              />
              <span className={styles.hintText}>
                {t('contentModeration.settings.categories.thresholdHint')}
              </span>
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
});

CategoriesSection.displayName = 'ModerationCategoriesSection';

export default CategoriesSection;
