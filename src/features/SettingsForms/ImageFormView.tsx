'use client';

import { type UserImageConfig } from '@lobechat/types';
import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton } from '@lobehub/ui';
import { toast } from '@lobehub/ui/base-ui';
import { Loader2Icon } from 'lucide-react';
import { memo, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FormSliderWithInput } from '@/components/FormInput';
import { FORM_STYLE } from '@/const/layoutTokens';
import { MAX_DEFAULT_IMAGE_NUM, MIN_DEFAULT_IMAGE_NUM } from '@/const/settings';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';

export interface ImageFormViewProps {
  canManage: boolean;
  disabledReason?: string;
  isInit: boolean;
  meta?: PlatformSettingMetaState;
  onChange: (patch: Partial<UserImageConfig>) => Promise<void> | void;
  /** When provided, drives AutoSaveHint (admin platform-defaults path). */
  saveState?: Pick<ReturnType<typeof useSaveState>, 'lastSavedAt' | 'retry' | 'save' | 'status'>;
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
  ({ canManage, disabledReason, isInit, meta = WRITABLE_META, onChange, saveState, value }) => {
    const { t } = useTranslation('setting');
    const [form] = Form.useForm<UserImageConfig>();
    const [isUpdating, setIsUpdating] = useState(false);
    const save = saveState?.save;
    const saveStatus = saveState?.status;
    const lastSavedAt = saveState?.lastSavedAt ?? null;
    const retry = saveState?.retry;

    // Keep Ant Form fields in sync when the parent revalidates / resets / rolls back.
    useLayoutEffect(() => {
      form.setFieldsValue(value);
    }, [form, value]);

    if (!isInit) {
      return <Skeleton active paragraph={{ rows: 1 }} title={false} />;
    }

    if (meta.hidden) return null;

    const commit = async (values: Partial<UserImageConfig>) => {
      try {
        await onChange(values);
      } catch (err) {
        form.setFieldsValue(value);
        toast.error(
          t('settingImage.defaultCount.saveFailed', {
            defaultValue: 'Could not update the default image count. Please try again.',
          }),
        );
        throw err;
      }
    };

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
        extra: saveState ? (
          <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus!} onRetry={retry} />
        ) : isUpdating ? (
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

          if (save) {
            await save(() => commit(values));
            return;
          }

          setIsUpdating(true);
          try {
            await commit(values);
          } catch {
            // Toast + rollback already handled in commit.
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
