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
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';

export interface ImageFormViewProps {
  canManage: boolean;
  disabledReason?: string;
  isInit: boolean;
  meta?: PlatformSettingMetaState;
  onChange: (patch: Partial<UserImageConfig>) => Promise<void> | void;
  value: UserImageConfig;
}

const WRITABLE_META: PlatformSettingMetaState = {
  canReset: false,
  enabled: true,
  error: undefined,
  hidden: false,
  isLoading: false,
  locked: false,
  meta: undefined,
  mode: 'user',
  reset: async () => false,
  resetError: null,
  resetting: false,
  retry: async () => undefined,
  source: 'user',
  status: 'ready',
};

/**
 * Pure controlled default-image-count form section.
 */
const ImageFormView = memo<ImageFormViewProps>(
  ({ canManage, disabledReason, isInit, meta = WRITABLE_META, onChange, value }) => {
    const { t } = useTranslation('setting');
    const [form] = Form.useForm<UserImageConfig>();
    const [isUpdating, setIsUpdating] = useState(false);

    if (!isInit) {
      return <Skeleton active paragraph={{ rows: 1 }} title={false} />;
    }

    if (meta.hidden) return null;

    const items: FormGroupItemType[] = [
      {
        children: [
          {
            children: (
              <ManagedFormControlContent
                disabledReason={disabledReason}
                extraDisabled={isUpdating || !canManage}
                meta={meta}
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
        initialValues={value}
        items={items}
        itemsType={'group'}
        variant={'filled'}
        onValuesChange={async (values) => {
          if (!canManage) return;

          setIsUpdating(true);
          try {
            await onChange(values);
          } finally {
            setIsUpdating(false);
          }
        }}
        {...FORM_STYLE}
      />
    );
  },
);

ImageFormView.displayName = 'ImageFormView';

export default ImageFormView;
