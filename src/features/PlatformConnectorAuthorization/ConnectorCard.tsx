'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { canDisconnectConnector, resolveConnectorAvailability } from './presentation';
import type { ManagedConnector } from './types';
import type { ConnectorActionFeedback } from './useConnectorAuthorizationActions';

const styles = createStaticStyles(({ css }) => ({
  header: css`
    align-items: flex-start;
  `,
  root: css`
    min-width: 0;
    border: 1px solid ${cssVar.colorBorderSecondary};
  `,
  tools: css`
    overflow: auto;
    max-height: 240px;
  `,
}));

interface ConnectorCardProps {
  actionsDisabled: boolean;
  authorizing: boolean;
  busy: boolean;
  connector: ManagedConnector;
  feedback: ConnectorActionFeedback | null;
  onAuthorize: (connectorId: string) => void;
  onCancelAuthorization: () => void;
  onDisconnect: (connectorId: string) => void;
}

const ConnectorCard = memo<ConnectorCardProps>(
  ({
    actionsDisabled,
    authorizing,
    busy,
    connector,
    feedback,
    onAuthorize,
    onCancelAuthorization,
    onDisconnect,
  }) => {
    const { t } = useTranslation('setting');
    const availability = resolveConnectorAvailability(connector);
    const connected = connector.binding?.status === 'connected';

    const requestDisconnect = () => {
      confirmModal({
        cancelText: t('platformConnectors.actions.cancel'),
        content: t('platformConnectors.disconnect.confirmDesc', { name: connector.displayName }),
        okButtonProps: { danger: true },
        okText: t('platformConnectors.actions.disconnect'),
        title: t('platformConnectors.disconnect.confirmTitle'),
        onOk: () => {
          void onDisconnect(connector.id);
        },
      });
    };

    return (
      <Block className={styles.root} padding={16} variant={'outlined'}>
        <Flexbox gap={16}>
          <Flexbox horizontal className={styles.header} gap={12} justify={'space-between'}>
            <Flexbox gap={4} style={{ minWidth: 0 }}>
              <Text ellipsis strong fontSize={16}>
                {connector.displayName}
              </Text>
              {connector.description ? (
                <Text type={'secondary'}>{connector.description}</Text>
              ) : null}
            </Flexbox>
            <Flexbox horizontal gap={8}>
              <Tag color={availability === 'available' ? 'success' : 'warning'}>
                {t(`platformConnectors.availability.${availability}` as never)}
              </Tag>
              <Tag>
                {t(`platformConnectors.credentialMode.${connector.credentialMode}` as never)}
              </Tag>
            </Flexbox>
          </Flexbox>

          {feedback?.connectorId === connector.id ? (
            <Alert
              showIcon
              message={t(`platformConnectors.feedback.${feedback.code}` as never)}
              type={feedback.type}
            />
          ) : null}

          <Flexbox gap={8}>
            <Text strong>{t('platformConnectors.tools.title')}</Text>
            <Text type={'secondary'}>{t('platformConnectors.tools.policyDesc')}</Text>
            <Flexbox className={styles.tools} gap={8} role={'list'}>
              {connector.tools.map((tool) => (
                <Flexbox
                  horizontal
                  gap={8}
                  justify={'space-between'}
                  key={tool.toolKey}
                  role={'listitem'}
                >
                  <Flexbox gap={2} style={{ minWidth: 0 }}>
                    <Text ellipsis>{tool.displayName}</Text>
                    {tool.description ? (
                      <Text ellipsis type={'secondary'}>
                        {tool.description}
                      </Text>
                    ) : null}
                  </Flexbox>
                  <Flexbox horizontal gap={4}>
                    <Tag color={tool.available ? 'success' : 'default'}>
                      {t(
                        tool.available
                          ? 'platformConnectors.tools.available'
                          : 'platformConnectors.tools.unavailable',
                      )}
                    </Tag>
                    {tool.riskLevel === 'high' || tool.riskLevel === 'critical' ? (
                      <Tag color={'warning'}>
                        {t(`platformConnectors.risk.${tool.riskLevel}` as never)}
                      </Tag>
                    ) : null}
                    {tool.requiresConfirmation ? (
                      <Tag color={'info'}>{t('platformConnectors.tools.confirmationRequired')}</Tag>
                    ) : null}
                  </Flexbox>
                </Flexbox>
              ))}
            </Flexbox>
          </Flexbox>

          {connector.credentialMode === 'per_user_oauth' ? (
            <Flexbox horizontal gap={8} justify={'flex-end'}>
              {canDisconnectConnector(connector.binding) ? (
                <Button
                  disabled={actionsDisabled}
                  loading={busy && !authorizing}
                  onClick={requestDisconnect}
                >
                  {t('platformConnectors.actions.disconnect')}
                </Button>
              ) : null}
              {authorizing ? (
                <Button danger onClick={onCancelAuthorization}>
                  {t('platformConnectors.actions.cancelAuthorization')}
                </Button>
              ) : null}
              <Button
                disabled={actionsDisabled}
                loading={authorizing}
                type={'primary'}
                onClick={() => void onAuthorize(connector.id)}
              >
                {t(
                  connected
                    ? 'platformConnectors.actions.reauthorize'
                    : 'platformConnectors.actions.authorize',
                )}
              </Button>
            </Flexbox>
          ) : (
            <Text type={'secondary'}>
              {t(`platformConnectors.credentialHelp.${connector.credentialMode}` as never)}
            </Text>
          )}
        </Flexbox>
      </Block>
    );
  },
);

ConnectorCard.displayName = 'ConnectorCard';

export default ConnectorCard;
