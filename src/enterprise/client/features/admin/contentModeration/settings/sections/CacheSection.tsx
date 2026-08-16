'use client';

import { Text } from '@lobehub/ui';
import { Button, InputNumber, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';

import ManageGuard from '../../ManageGuard';
import { moderationStyles as styles } from '../../styles';
import type { ModerationConfigView } from '../draft';
import Field from '../Field';
import SettingsSection from '../SettingsSection';

export interface CacheSectionProps {
  canManage: boolean;
  clearing: boolean;
  config: ModerationConfigView;
  disabled: boolean;
  onClearCache: () => void;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

/** 决策缓存 (design §6.3.6). TTL 0 disables caching without losing the configured value. */
const CacheSection = memo<CacheSectionProps>(
  ({ canManage, clearing, config, disabled, onClearCache, onPatch }) => {
    const { t } = useTranslation('admin');
    const cache = config.decisionCache;

    const clearButton = (
      <Button
        disabled={!canManage || clearing}
        loading={clearing}
        size="small"
        onClick={onClearCache}
      >
        {t('contentModeration.overview.clearCache')}
      </Button>
    );

    return (
      <SettingsSection
        actions={<ManageGuard allowed={canManage}>{clearButton}</ManageGuard>}
        description={t('contentModeration.settings.cache.desc')}
        title={t('contentModeration.settings.cache.title')}
      >
        <div className={styles.formRow}>
          <Field label={t('contentModeration.settings.cache.enabled')}>
            <div className={styles.toolbarRow}>
              <Switch
                checked={cache.enabled}
                disabled={disabled}
                onChange={(checked) =>
                  onPatch({ decisionCache: { ...cache, enabled: Boolean(checked) } })
                }
              />
              <Text className={styles.hintText}>
                {t('contentModeration.settings.cache.enabledHint')}
              </Text>
            </div>
          </Field>
          <Field
            hint={t('contentModeration.settings.cache.ttlHint')}
            label={t('contentModeration.settings.cache.ttl')}
          >
            <InputNumber
              disabled={disabled || !cache.enabled}
              max={MODERATION_LIMITS.DECISION_CACHE_TTL_MAX_HOURS}
              min={0}
              step={1}
              style={{ width: 140 }}
              value={cache.ttlHours}
              onChange={(next) =>
                onPatch({ decisionCache: { ...cache, ttlHours: Number(next ?? 0) } })
              }
            />
          </Field>
        </div>
      </SettingsSection>
    );
  },
);

CacheSection.displayName = 'ModerationCacheSection';

export default CacheSection;
