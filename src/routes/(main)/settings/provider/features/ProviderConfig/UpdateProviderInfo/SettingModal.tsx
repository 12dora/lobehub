'use client';

import { ProviderIcon } from '@lobehub/icons';
import { Flexbox, Icon, Input, Text, TextArea } from '@lobehub/ui';
import {
  Button,
  confirmModal,
  createModal,
  ModalFooter,
  type ModalInstance,
  Select,
  useModalContext,
} from '@lobehub/ui/base-ui';
import { App, Form } from 'antd';
import { cssVar } from 'antd-style';
import { t as i18nT } from 'i18next';
import { BrainIcon } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import {
  type AiInfraStoreApi,
  AiInfraStoreProvider,
  aiProviderSelectors,
  useScopedAiInfraStore as useAiInfraStore,
} from '@/store/aiInfra';
import {
  type AiProviderDetailItem,
  type AiProviderSettings,
  type UpdateAiProviderParams,
} from '@/types/aiProvider';

import { providerSettingsPath } from '../../../providerRouteBase';
import { CUSTOM_PROVIDER_SDK_OPTIONS } from '../../customProviderSdkOptions';
import {
  isResponsesApiSupportedSdkType,
  normalizeProviderSettings,
  OPENAI_RESPONSES_SDK_OPTION,
  type RequestFormatOptionValue,
  resolveRequestFormat,
  toRequestFormatOption,
} from '../../providerSettings';

interface SettingContentProps {
  id: string;
  initialValues: AiProviderDetailItem;
}

const SectionTitle = memo<{ children: ReactNode }>(({ children }) => (
  <Text fontSize={13} type={'secondary'} weight={500}>
    {children}
  </Text>
));

SectionTitle.displayName = 'SectionTitle';

const itemStyle = { marginBottom: 0 };

const SettingContent = memo<SettingContentProps>(({ initialValues, id }) => {
  const { t } = useTranslation(['modelProvider', 'common']);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<UpdateAiProviderParams>();
  const [updateAiProvider, deleteAiProvider] = useAiInfraStore((s) => [
    s.updateAiProvider,
    s.deleteAiProvider,
  ]);

  const { message } = App.useApp();
  const navigate = useWorkspaceAwareNavigate();
  const location = useLocation();
  const { close } = useModalContext();

  const onFinish = async (values: UpdateAiProviderParams) => {
    setLoading(true);

    try {
      // The "请求格式" dropdown may carry the synthetic `openai-responses` value; translate it
      // into the real sdkType. Only the sdkType is taken here — the enableResponseApi flag is
      // decided below in a way that never clobbers an existing manual toggle.
      const isResponsesOption = values.settings?.sdkType === OPENAI_RESPONSES_SDK_OPTION;
      const { sdkType } = resolveRequestFormat(
        values.settings?.sdkType as RequestFormatOptionValue | undefined,
      );

      const finalValues: UpdateAiProviderParams = {
        ...values,
        settings: normalizeProviderSettings({
          nextSettings: { ...values.settings, sdkType } as AiProviderSettings,
          previousSettings: initialValues.settings,
        }) as UpdateAiProviderParams['settings'],
      };

      // Decide config.enableResponseApi WITHOUT wiping an existing choice (the provider detail
      // does not carry config, so we must not force it off blindly):
      // - the synthetic "OpenAI Response" option turns it on;
      // - switching to an SDK that cannot use the Responses API clears a stale flag (original
      //   behavior);
      // - plain OpenAI / router keep whatever the ProviderConfig "使用 Responses API 规范"
      //   toggle already set.
      const resolvedSdkType = finalValues.settings?.sdkType;
      let nextEnableResponseApi: boolean | undefined;
      if (isResponsesOption) {
        nextEnableResponseApi = true;
      } else if (resolvedSdkType && !isResponsesApiSupportedSdkType(resolvedSdkType)) {
        nextEnableResponseApi = false;
      }

      if (nextEnableResponseApi !== undefined) {
        const previousConfig = (initialValues as { config?: UpdateAiProviderParams['config'] })
          .config;

        finalValues.config = {
          ...previousConfig,
          ...finalValues.config,
          enableResponseApi: nextEnableResponseApi,
        };
      }

      await updateAiProvider(id, finalValues);
      setLoading(false);
      message.success(t('updateAiProvider.updateSuccess'));
      close();
    } catch (e) {
      console.error(e);
      setLoading(false);
    }
  };

  const handleDelete = () => {
    confirmModal({
      content: t('updateAiProvider.confirmDeleteDescription'),
      okButtonProps: { danger: true },
      okText: t('delete', { ns: 'common' }),
      onOk: async () => {
        await deleteAiProvider(id);
        navigate(providerSettingsPath(location.pathname, 'all'));
        close();
        message.success(t('updateAiProvider.deleteSuccess'));
      },
      title: t('updateAiProvider.confirmDelete'),
    });
  };

  // Seed the "请求格式" dropdown with the synthetic Responses option when the existing provider
  // is OpenAI SDK + Responses API, so the edit form round-trips. The provider detail does not
  // carry `config`, so read the effective flag from the runtime config selector.
  const enableResponseApi = useAiInfraStore(aiProviderSelectors.isProviderEnableResponseApi(id));
  const formInitialValues = {
    ...initialValues,
    settings: {
      ...initialValues.settings,
      sdkType: toRequestFormatOption(initialValues.settings?.sdkType, enableResponseApi),
    },
  } as AiProviderDetailItem;

  return (
    <Flexbox>
      <Form
        colon={false}
        form={form}
        initialValues={formInitialValues}
        layout={'vertical'}
        scrollToFirstError={{ behavior: 'instant', block: 'end', focus: true }}
        onFinish={onFinish}
      >
        <Flexbox gap={16}>
          <SectionTitle>{t('createNewAiProvider.basicTitle')}</SectionTitle>

          <Form.Item label={t('createNewAiProvider.id.title')} style={itemStyle}>
            <Text type={'secondary'}>{initialValues.id}</Text>
          </Form.Item>

          <Form.Item
            label={t('createNewAiProvider.name.title')}
            name={'name'}
            rules={[{ message: t('createNewAiProvider.name.required'), required: true }]}
            style={itemStyle}
          >
            <Input placeholder={t('createNewAiProvider.name.placeholder')} variant={'filled'} />
          </Form.Item>

          <Form.Item
            label={t('createNewAiProvider.description.title')}
            name={'description'}
            style={itemStyle}
          >
            <TextArea
              placeholder={t('createNewAiProvider.description.placeholder')}
              style={{ minHeight: 72 }}
              variant={'filled'}
            />
          </Form.Item>

          <Form.Item label={t('createNewAiProvider.logo.title')} name={'logo'} style={itemStyle}>
            <Input allowClear placeholder={'https://logo-url'} variant={'filled'} />
          </Form.Item>

          <div style={{ marginBlockStart: 8 }}>
            <SectionTitle>{t('createNewAiProvider.configTitle')}</SectionTitle>
          </div>

          <Form.Item
            label={t('createNewAiProvider.sdkType.title')}
            name={['settings', 'sdkType']}
            rules={[{ message: t('createNewAiProvider.sdkType.required'), required: true }]}
            style={itemStyle}
          >
            <Select
              options={CUSTOM_PROVIDER_SDK_OPTIONS}
              placeholder={t('createNewAiProvider.sdkType.placeholder')}
              variant={'filled'}
              optionRender={({ label, value }) => {
                const iconProvider =
                  value === 'router'
                    ? 'newapi'
                    : value === OPENAI_RESPONSES_SDK_OPTION
                      ? 'openai'
                      : (value as string);
                return (
                  <Flexbox horizontal align={'center'} gap={8}>
                    <ProviderIcon provider={iconProvider} size={18} />
                    {label}
                  </Flexbox>
                );
              }}
            />
          </Form.Item>
        </Flexbox>
      </Form>
      <ModalFooter
        style={{
          borderBlockStart: `1px solid ${cssVar.colorBorderSecondary}`,
          marginTop: 16,
          padding: 0,
        }}
      >
        <Button danger disabled={loading} type={'primary'} onClick={handleDelete}>
          {t('delete', { ns: 'common' })}
        </Button>
        <Button loading={loading} type={'primary'} onClick={() => form.submit()}>
          {t('update', { ns: 'common' })}
        </Button>
      </ModalFooter>
    </Flexbox>
  );
});

SettingContent.displayName = 'SettingContent';

/**
 * Imperative update-provider modal. Content mounts under ModalHost outside the page
 * AiInfraStoreProvider tree — callers must pass the scoped store API.
 */
export const createSettingModal = (
  props: SettingContentProps & { store: AiInfraStoreApi },
): ModalInstance => {
  const { store, ...contentProps } = props;
  return createModal({
    content: (
      <AiInfraStoreProvider store={store}>
        <SettingContent {...contentProps} />
      </AiInfraStoreProvider>
    ),
    footer: null,
    maskClosable: true,

    title: (
      <Flexbox horizontal align={'center'} gap={8}>
        <Icon icon={BrainIcon} />
        {i18nT('updateCustomAiProvider.title', { ns: 'modelProvider' })}
      </Flexbox>
    ),
    width: 'min(90vw, 640px)',
  });
};
