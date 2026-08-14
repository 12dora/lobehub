'use client';

import { Button, Tooltip } from '@lobehub/ui';
import isEqual from 'fast-deep-equal';
import { SettingsIcon } from 'lucide-react';
import { memo, use } from 'react';
import { useTranslation } from 'react-i18next';

import { usePermission } from '@/hooks/usePermission';
import {
  aiProviderSelectors,
  useAiInfraStoreApi,
  useScopedAiInfraStore as useAiInfraStore,
} from '@/store/aiInfra';

import { ProviderSettingsContext } from '../../ModelList/ProviderSettingsContext';
import { createSettingModal } from './SettingModal';

const UpdateProviderInfo = memo(() => {
  const { t } = useTranslation('modelProvider');

  const providerConfig = useAiInfraStore(aiProviderSelectors.activeProviderConfig, isEqual);
  const aiInfraStoreApi = useAiInfraStoreApi();
  // The modal mounts under ModalHost, outside this tree — read the surface overrides here and
  // hand them over explicitly, the same way the scoped store is passed.
  const { deleteConfirmDescription } = use(ProviderSettingsContext);
  const { allowed: canManageProvider, reason } = usePermission('manage_provider_key');

  return (
    <Tooltip title={canManageProvider ? t('updateAiProvider.tooltip') : reason}>
      <Button
        disabled={!canManageProvider}
        icon={SettingsIcon}
        size={'small'}
        type={'text'}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!canManageProvider || !providerConfig) return;
          createSettingModal({
            deleteConfirmDescription,
            id: providerConfig.id,
            initialValues: providerConfig,
            store: aiInfraStoreApi,
          });
        }}
      />
    </Tooltip>
  );
});

export default UpdateProviderInfo;
