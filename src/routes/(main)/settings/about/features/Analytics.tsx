'use client';

import { type FormGroupItemType } from '@lobehub/ui';
import { Form } from '@lobehub/ui';
import { Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { FORM_STYLE } from '@/const/layoutTokens';
import { useBranding } from '@/enterprise/client/providers/RuntimeBrandingProvider';
import { ManagedSettingFieldContent } from '@/features/PlatformSettingSourceBadge/ManagedSettingField';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/selectors';

const Analytics = memo(() => {
  const { t } = useTranslation('setting');
  const branding = useBranding();
  const checked = useUserStore(userGeneralSettingsSelectors.telemetry);
  const updateGeneralConfig = useUserStore((s) => s.updateGeneralConfig);
  const telemetryMeta = usePlatformSettingMeta('general.telemetry');

  if (telemetryMeta.hidden) return null;

  const items: FormGroupItemType = {
    children: [
      {
        children: (
          <ManagedSettingFieldContent meta={telemetryMeta}>
            {({ disabled }) => (
              <Switch
                checked={!!checked}
                disabled={disabled}
                onChange={(e) => {
                  if (disabled) return;
                  updateGeneralConfig({ telemetry: e });
                }}
              />
            )}
          </ManagedSettingFieldContent>
        ),
        desc: t('analytics.telemetry.desc', { appName: branding.name }),
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
