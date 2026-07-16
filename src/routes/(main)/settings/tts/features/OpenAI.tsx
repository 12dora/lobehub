'use client';

import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import isEqual from 'fast-deep-equal';
import { Loader2Icon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FORM_STYLE } from '@/const/layoutTokens';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import { usePlatformSettingMeta } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import { usePermission } from '@/hooks/usePermission';
import { useUserStore } from '@/store/user';
import { settingsSelectors } from '@/store/user/selectors';

import { opeanaiTTSOptions } from './const';

const OpenAI = memo(() => {
  const { t } = useTranslation('setting');
  const { allowed: canManageServiceModel, reason } = usePermission('manage_settings');
  const [form] = Form.useForm();
  const { tts } = useUserStore(settingsSelectors.currentSettings, isEqual);
  const [setSettings, isUserStateInit] = useUserStore((s) => [s.setSettings, s.isUserStateInit]);
  const [loading, setLoading] = useState(false);
  const ttsModelMeta = usePlatformSettingMeta('tts.openAI.ttsModel');

  if (!isUserStateInit) return <Skeleton active paragraph={{ rows: 5 }} title={false} />;
  if (ttsModelMeta.hidden) return null;

  const openai: FormGroupItemType = {
    children: [
      {
        children: (
          <ManagedFormControlContent
            disabledReason={reason}
            extraDisabled={!canManageServiceModel}
            meta={ttsModelMeta}
          >
            <Select options={opeanaiTTSOptions} style={{ width: 448 }} />
          </ManagedFormControlContent>
        ),
        label: t('settingTTS.openai.ttsModel'),
        name: ['openAI', 'ttsModel'],
      },
    ],
    extra: loading && <Icon spin icon={Loader2Icon} size={16} style={{ opacity: 0.5 }} />,
    title: t('settingTTS.openai.title'),
  };

  return (
    <Form
      collapsible={false}
      form={form}
      initialValues={tts}
      items={[openai]}
      itemsType={'group'}
      variant={'filled'}
      onValuesChange={async (values) => {
        if (!canManageServiceModel) return;

        setLoading(true);
        await setSettings({
          tts: values,
        });
        setLoading(false);
      }}
      {...FORM_STYLE}
      itemMinWidth={undefined}
    />
  );
});

export default OpenAI;
