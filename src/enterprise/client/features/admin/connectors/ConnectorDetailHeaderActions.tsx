'use client';

import { Flexbox } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ConnectorDetailHeaderActionsModel } from './connectorDetailViewModel';

interface ConnectorDetailHeaderActionsProps {
  model: ConnectorDetailHeaderActionsModel;
  onArchive: () => void;
  onDeleteDraft: () => void;
  onDiscover: () => void;
  onRevokeBindings: () => void;
  onRollback: () => void;
}

const ConnectorDetailHeaderActions = memo<ConnectorDetailHeaderActionsProps>(
  ({ model, onArchive, onDeleteDraft, onDiscover, onRevokeBindings, onRollback }) => {
    const { t } = useTranslation('admin');

    return (
      <Flexbox horizontal gap={8}>
        {model.showDiscover ? (
          <Button disabled={model.disabled} onClick={onDiscover}>
            {t('connectorCatalog.actions.discover')}
          </Button>
        ) : null}
        {model.showRevokeBindings ? (
          <Button danger disabled={model.disabled} onClick={onRevokeBindings}>
            {t('connectorCatalog.actions.revokeBindings')}
          </Button>
        ) : null}
        {model.showRollback ? (
          <Button
            danger
            disabled={model.disabled}
            loading={model.rollbackLoading}
            onClick={onRollback}
          >
            {t('connectorCatalog.actions.rollback')}
          </Button>
        ) : null}
        {model.showArchive ? (
          <Button danger disabled={model.disabled} onClick={onArchive}>
            {t('connectorCatalog.actions.archive')}
          </Button>
        ) : null}
        {model.showDeleteDraft ? (
          <Button danger disabled={model.disabled} onClick={onDeleteDraft}>
            {t('connectorCatalog.actions.deleteDraft')}
          </Button>
        ) : null}
      </Flexbox>
    );
  },
);

ConnectorDetailHeaderActions.displayName = 'AdminConnectorDetailHeaderActions';

export default ConnectorDetailHeaderActions;
