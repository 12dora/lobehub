'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminConnectorSaveState,
  ConnectorDetailFooterModel,
} from './connectorDetailViewModel';
import type { AdminConnectorPrimaryAction } from './controller';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
}));

interface ConnectorDetailFooterProps {
  model: ConnectorDetailFooterModel;
  onPrimaryAction: (action: AdminConnectorPrimaryAction) => void;
  saveState: AdminConnectorSaveState;
}

const ConnectorDetailFooter = memo<ConnectorDetailFooterProps>(
  ({ model, onPrimaryAction, saveState }) => {
    const { t } = useTranslation('admin');
    const { publish, save, test } = model;

    return (
      <div className={styles.footer}>
        <Text type={model.saveStateTone}>
          {t(`connectorCatalog.saveState.${saveState}` as never)}
        </Text>
        <Flexbox horizontal gap={8}>
          {test ? (
            <Button
              disabled={test.disabled}
              loading={test.loading}
              type={test.primary ? 'primary' : undefined}
              onClick={() => onPrimaryAction('test')}
            >
              {t('connectorCatalog.actions.test')}
            </Button>
          ) : null}
          {save ? (
            <Button
              disabled={save.disabled}
              loading={save.loading}
              type={'primary'}
              onClick={() => onPrimaryAction(save.action)}
            >
              {t(save.labelKey as never)}
            </Button>
          ) : null}
          {publish ? (
            <Button
              disabled={publish.disabled}
              loading={publish.loading}
              type={'primary'}
              onClick={() => onPrimaryAction('publish')}
            >
              {t('connectorCatalog.actions.publish')}
            </Button>
          ) : null}
        </Flexbox>
      </div>
    );
  },
);

ConnectorDetailFooter.displayName = 'AdminConnectorDetailFooter';

export default ConnectorDetailFooter;
