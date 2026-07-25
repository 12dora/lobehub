'use client';

import { type FormGroupItemType } from '@lobehub/ui';
import { Form, Icon, Skeleton } from '@lobehub/ui';
import { Select, toast } from '@lobehub/ui/base-ui';
import { Loader2Icon } from 'lucide-react';
import { memo, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AutoSaveHint from '@/components/Editor/AutoSaveHint';
import { FORM_STYLE } from '@/const/layoutTokens';
import { ManagedFormControlContent } from '@/features/PlatformSettingSourceBadge/ManagedFormControl';
import type { PlatformSettingMetaState } from '@/features/PlatformSettingSourceBadge/usePlatformSettingMeta';
import type { useSaveState } from '@/hooks/useSaveState';

import { opeanaiTTSOptions } from './openaiTtsOptions';

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
  /** When provided, drives AutoSaveHint (admin platform-defaults path). */
  saveState?: Pick<ReturnType<typeof useSaveState>, 'lastSavedAt' | 'retry' | 'save' | 'status'>;
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
  ({
    canManage,
    disabledReason,
    isInit,
    onChange,
    saveState,
    ttsModelMeta = WRITABLE_META,
    value,
  }) => {
    const { t } = useTranslation('setting');
    const [form] = Form.useForm();
    const [loading, setLoading] = useState(false);
    const save = saveState?.save;
    const saveStatus = saveState?.status;
    const lastSavedAt = saveState?.lastSavedAt ?? null;
    const retry = saveState?.retry;

    // Keep Ant Form fields in sync when the parent revalidates / resets / rolls back.
    useLayoutEffect(() => {
      form.setFieldsValue(value);
    }, [form, value]);

    if (!isInit) return <Skeleton active paragraph={{ rows: 5 }} title={false} />;
    if (ttsModelMeta.hidden) return null;

    const commit = async (values: OpenAITtsFormValue) => {
      try {
        await onChange(values);
      } catch (err) {
        form.setFieldsValue(value);
        toast.error(
          t('settingTTS.openai.saveFailed', {
            defaultValue: 'Could not update the TTS model. Please try again.',
          }),
        );
        throw err;
      }
    };

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
      extra: saveState ? (
        <AutoSaveHint lastUpdatedTime={lastSavedAt} saveStatus={saveStatus!} onRetry={retry} />
      ) : (
        loading && <Icon spin icon={Loader2Icon} size={16} style={{ opacity: 0.5 }} />
      ),
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

          if (save) {
            await save(() => commit(values));
            return;
          }

          setLoading(true);
          try {
            await commit(values);
          } catch {
            // Toast + rollback already handled in commit.
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
