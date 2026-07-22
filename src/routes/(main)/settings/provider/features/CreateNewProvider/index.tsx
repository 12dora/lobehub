'use client';

import { Flexbox, Icon } from '@lobehub/ui';
import { createModal, type ModalInstance } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { BrainIcon } from 'lucide-react';

import { type AiInfraStoreApi, AiInfraStoreProvider } from '@/store/aiInfra';

import CreateNewProviderContent from './Content';

/**
 * Imperative create-provider modal. Content mounts under ModalHost (outside the page
 * React tree), so callers must pass the scoped AiInfraStoreApi; we re-provide it here.
 * On the user settings page the global singleton is passed — zero behavior change.
 */
export const createCreateNewProviderModal = (store: AiInfraStoreApi): ModalInstance =>
  createModal({
    content: (
      <AiInfraStoreProvider store={store}>
        <CreateNewProviderContent />
      </AiInfraStoreProvider>
    ),
    footer: null,
    maskClosable: true,
    styles: {
      content: { paddingBlock: 16, paddingInline: 24 },
    },
    title: (
      <Flexbox horizontal align={'center'} gap={8}>
        <Icon icon={BrainIcon} />
        {t('createNewAiProvider.title', { ns: 'modelProvider' })}
      </Flexbox>
    ),
    width: 'min(90vw, 640px)',
  });
