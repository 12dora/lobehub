'use client';

import type { ModalInstance } from '@lobehub/ui/base-ui';
import { createModal } from '@lobehub/ui/base-ui';
import type { FormInstance } from 'antd';
import { t } from 'i18next';

import { type AiInfraStoreApi, AiInfraStoreProvider } from '@/store/aiInfra';

import CreateNewModelContent from './Content';
import CreateNewModelFooter from './Footer';

interface CreateNewModelModalOptions {
  existingModelIds?: string[];
  showDeployName?: boolean;
  /** Scoped store from the call site (user singleton or admin store). */
  store: AiInfraStoreApi;
}

/**
 * Imperative create-model modal. Footer/content read useScopedAiInfraStore, so they must
 * re-enter the caller's AiInfraStoreProvider (ModalHost mounts outside the page tree).
 */
export const createCreateNewModelModal = (options: CreateNewModelModalOptions): ModalInstance => {
  const formRef: { current?: FormInstance } = {};
  const { store, existingModelIds, showDeployName } = options;

  return createModal({
    content: (
      <AiInfraStoreProvider store={store}>
        <CreateNewModelContent
          existingModelIds={existingModelIds}
          showDeployName={showDeployName}
          onFormReady={(instance) => {
            formRef.current = instance;
          }}
        />
      </AiInfraStoreProvider>
    ),
    footer: (
      <AiInfraStoreProvider store={store}>
        <CreateNewModelFooter formRef={formRef} />
      </AiInfraStoreProvider>
    ),
    maskClosable: true,
    title: t('providerModels.createNew.title', { ns: 'modelProvider' }),
    width: 'min(90vw, 640px)',
  });
};
