'use client';

import { type UserImageConfig } from '@lobechat/types';
import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton } from '@lobehub/ui';
import { Loader2Icon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FormSliderWithInput } from '@/components/FormInput';
import { FORM_STYLE } from '@/const/layoutTokens';
import { MAX_DEFAULT_IMAGE_NUM, MIN_DEFAULT_IMAGE_NUM } from '@/const/settings';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/slices/settings/selectors';

const ImageSettings = memo(() => {
  const { t } = useTranslation('setting');
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const [form] = Form.useForm<UserImageConfig>();
  const [isUpdating, setIsUpdating] = useState(false);
  const defaultImageNumMeta = usePlatformSettingMeta('image.defaultImageNum');

  const imageSettings = useUserStore(settingsSelectors.currentImageSettings);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);

  if (!isUserStateInit) {
    return <Skeleton active paragraph={{ rows: 1 }} title={false} />;
  }

  if (defaultImageNumMeta.hidden) return null;

  const items: FormGroupItemType[] = [
    {
      children: [
        {
          children: (
            <ManagedFormControlContent
              disabledReason={reason}
              extraDisabled={isUpdating || !canManageServiceModel}
              meta={defaultImageNumMeta}
            >
              <FormSliderWithInput
                max={MAX_DEFAULT_IMAGE_NUM}
                min={MIN_DEFAULT_IMAGE_NUM}
                step={1}
              />
            </ManagedFormControlContent>
          ),
          desc: t('settingImage.defaultCount.desc'),
          label: t('settingImage.defaultCount.label'),
          name: 'defaultImageNum',
        },
      ],
      extra: isUpdating ? (
        <Icon spin icon={Loader2Icon} size={16} style={{ opacity: 0.6 }} />
      ) : undefined,
      title: t('settingImage.defaultCount.title'),
    },
  ];

  return (
    <Form
      collapsible={false}
      form={form}
      initialValues={imageSettings}
      items={items}
      itemsType={'group'}
      variant={'filled'}
      onValuesChange={async (values) => {
        if (!canManageServiceModel) return;

        setIsUpdating(true);
        try {
          await setSettings({ image: values });
        } finally {
          setIsUpdating(false);
        }
      }}
      {...FORM_STYLE}
    />
  );
});

ImageSettings.displayName = 'ImageSettings';

export default ImageSettings;
