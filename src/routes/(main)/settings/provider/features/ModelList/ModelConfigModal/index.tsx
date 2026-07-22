'use client';

import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import { type FormInstance } from 'antd';
import { t } from 'i18next';

import { type AiInfraStoreApi, AiInfraStoreProvider } from '@/store/aiInfra';

import ModelConfigContent from './Content';
import ModelConfigFooter from './Footer';

interface ModelConfigModalOptions {
  id: string;
  showDeployName?: boolean;
  /** Scoped store from the call site (user singleton or admin store). */
  store: AiInfraStoreApi;
}

/**
 * Imperative model-config modal. Content/footer use useScopedAiInfraStore — re-provide
 * the caller's store so admin parity pages do not fall back to the user singleton.
 */
export const createModelConfigModal = (options: ModelConfigModalOptions): ModalInstance => {
  const formRef: { current?: FormInstance } = {};
  const { store, id, showDeployName } = options;

  return createModal({
    content: (
      <AiInfraStoreProvider store={store}>
        <ModelConfigContent
          id={id}
          showDeployName={showDeployName}
          onFormReady={(instance) => {
            formRef.current = instance;
          }}
        />
      </AiInfraStoreProvider>
    ),
    footer: (
      <AiInfraStoreProvider store={store}>
        <ModelConfigFooter formRef={formRef} id={id} />
      </AiInfraStoreProvider>
    ),
    maskClosable: true,
    title: t('llm.customModelCards.modelConfig.modalTitle', { ns: 'setting' }),
    width: 'min(90vw, 640px)',
  });
};
