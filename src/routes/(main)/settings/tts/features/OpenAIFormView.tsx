'use client';

import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { Loader2Icon } from 'lucide-react';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FORM_STYLE } from '@/const/layoutTokens';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';

import { opeanaiTTSOptions } from './const';

export interface OpenAITtsFormValue {
  openAI?: {
    ttsModel?: string;
  };
}

export interface OpenAIFormViewProps {
  canManage: boolean;
  disabledReason?: string;
  isInit: boolean;
  onChange: (patch: OpenAITtsFormValue) => Promise<void> | void;
  ttsModelMeta?: PlatformSettingMetaState;
  value: OpenAITtsFormValue;
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
 * Pure controlled OpenAI TTS model section (used on service-model + TTS pages).
 */
const OpenAIFormView = memo<OpenAIFormViewProps>(
  ({ canManage, disabledReason, isInit, onChange, ttsModelMeta = WRITABLE_META, value }) => {
    const { t } = useTranslation('setting');
    const [form] = Form.useForm();
    const [loading, setLoading] = useState(false);

    if (!isInit) return <Skeleton active paragraph={{ rows: 5 }} title={false} />;
    if (ttsModelMeta.hidden) return null;

    const openai: FormGroupItemType = {
      children: [
        {
          children: (
            <ManagedFormControlContent
              disabledReason={disabledReason}
              extraDisabled={!canManage}
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
        initialValues={value}
        items={[openai]}
        itemsType={'group'}
        variant={'filled'}
        onValuesChange={async (values) => {
          if (!canManage) return;

          setLoading(true);
          try {
            await onChange(values);
          } finally {
            setLoading(false);
          }
        }}
        {...FORM_STYLE}
        itemMinWidth={undefined}
      />
    );
  },
);

OpenAIFormView.displayName = 'OpenAIFormView';

export default OpenAIFormView;
