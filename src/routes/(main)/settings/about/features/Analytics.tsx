'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import { type FormGroupItemType } from '@lobehub/ui';
import { Form } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { FORM_STYLE } from '@/const/layoutTokens';
import PlatformSettingSourceBadge from '@/features/PlatformSettingSourceBadge';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

const Analytics = memo(() => {
  const { t } = useTranslation('setting');
  const checked = useUserStore(userGeneralSettingsSelectors.telemetry);
  const updateGeneralConfig = useUserStore((s) => s.updateGeneralConfig);
  const telemetryMeta = usePlatformSettingMeta('general.telemetry');

  // U1-R2: flag OFF renders exact unmanaged control; only hide when policy says hidden
  if (telemetryMeta.status === 'loading') return null;
  if (telemetryMeta.status === 'error') {
    return (
      <button type="button" onClick={() => telemetryMeta.retry()}>
        {t('platformSource.retryMeta', { defaultValue: 'Retry loading settings policy' })}
      </button>
    );
  }
  if (telemetryMeta.hidden) return null;

  const items: FormGroupItemType = {
    children: [
      {
        children: (
          <div>
            {telemetryMeta.enabled ? (
              <PlatformSettingSourceBadge
                locked={telemetryMeta.locked}
                mode={telemetryMeta.mode}
                source={telemetryMeta.source}
                onReset={
                  telemetryMeta.mode === 'default' && telemetryMeta.source === 'user'
                    ? () => {
                        void telemetryMeta.reset().catch(() => {});
                      }
                    : undefined
                }
              />
            ) : null}
            {telemetryMeta.resetError ? (
              <button type="button" onClick={() => void telemetryMeta.reset().catch(() => {})}>
                {t('platformSource.retryReset', { defaultValue: 'Retry reset' })}
              </button>
            ) : null}
            <Switch
              checked={!!checked}
              disabled={telemetryMeta.locked || telemetryMeta.resetting}
              onChange={(e) => {
                if (telemetryMeta.locked) return;
                updateGeneralConfig({ telemetry: e });
              }}
            />
          </div>
        ),
        desc: t('analytics.telemetry.desc', { appName: BRANDING_NAME }),
        label: t('analytics.telemetry.title'),
        minWidth: undefined,
        valuePropName: 'checked',
      },
    ],
    title: t('analytics.title'),
  };

  return (
    <Form
      collapsible={false}
      items={[items]}
      itemsType={'group'}
      variant={'filled'}
      {...FORM_STYLE}
    />
  );
});

export default Analytics;
