'use client';

import { Button, confirmModal } from '@lobehub/ui/base-ui';
import { Unplug } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

export const shouldSyncConnectorDefinition = (params: {
  isConnectorType: boolean;
  managed: boolean;
}): boolean => params.isConnectorType && !params.managed;

interface ManagedComposioDisconnectButtonProps {
  canEdit: boolean;
  identifier: string;
  label: string;
  onDisconnect: (identifier: string) => Promise<void>;
  onDisconnected?: () => void;
}

export const ManagedComposioDisconnectButton = memo<ManagedComposioDisconnectButtonProps>(
  ({ canEdit, identifier, label, onDisconnect, onDisconnected }) => {
    const { t } = useTranslation('setting');
    return (
      <Button
        danger
        disabled={!canEdit}
        icon={<Unplug size={14} />}
        size="small"
        onClick={() => {
          if (!canEdit) return;
          confirmModal({
            cancelText: t('cancel', { ns: 'common' }),
            content: t('tools.lobehubSkill.disconnectConfirm.desc', { name: label }),
            okButtonProps: { danger: true },
            okText: t('tools.composio.disconnect', { defaultValue: 'Disconnect' }),
            onOk: async () => {
              await onDisconnect(identifier);
              onDisconnected?.();
            },
            title: t('tools.lobehubSkill.disconnectConfirm.title', { name: label }),
          });
        }}
      >
        {t('tools.composio.disconnect', { defaultValue: 'Disconnect' })}
      </Button>
    );
  },
);

ManagedComposioDisconnectButton.displayName = 'ManagedComposioDisconnectButton';
