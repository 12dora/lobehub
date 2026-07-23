'use client';

import type { PlatformAgentConnectorDependencyRef } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import {
  allowedConnectorToolKeys,
  type PublishedConnectorDetail,
  type PublishedConnectorSummary,
} from './dependencyCatalog';
import {
  DetailFetchBody,
  LoadingHint,
  RetryAction,
  RevalidatingHint,
} from './dependencyEditorShared';

interface SelectOption {
  label: string;
  value: string;
}

interface SwrSlice<T> {
  data?: T;
  error?: unknown;
  isLoading?: boolean;
  isValidating?: boolean;
  mutate: () => Promise<unknown>;
}

export interface ConnectorDependencyFieldProps {
  connectorDetail: SwrSlice<PublishedConnectorDetail | null>;
  connectorDetailUsable: boolean;
  connectorId: string | undefined;
  connectorOptions: SelectOption[];
  connectorRefDetails: SwrSlice<unknown>;
  connectors: SwrSlice<PublishedConnectorSummary[]>;
  connectorsListUsable: boolean;
  connectorsSettled: boolean;
  editable: boolean;
  enabled: boolean;
  onAdd: () => void;
  onRemove: (connectorKey: string) => void;
  onSelectConnector: (connectorId: string | undefined) => void;
  onUpdateExisting: (connectorKey: string) => void;
  staleConnectors: string[];
  value: PlatformAgentConnectorDependencyRef[];
}

const ConnectorValidationBanner = ({
  connectorsSettled,
  enabled,
  hasRefs,
  connectorRefDetails,
}: {
  connectorRefDetails: SwrSlice<unknown>;
  connectorsSettled: boolean;
  enabled: boolean;
  hasRefs: boolean;
}) => {
  const { t } = useTranslation('admin');

  // Referenced-connector validation: error / in-flight revalidation blocks save (fails closed)
  // and is surfaced with a sanitized message + explicit retry.
  if (!enabled || !hasRefs) return null;

  if (connectorRefDetails.error) {
    return (
      <Alert
        showIcon
        action={<RetryAction mutate={connectorRefDetails.mutate} />}
        message={t('agentCatalog.dependency.connector.validateError')}
        type="error"
      />
    );
  }

  if (!connectorsSettled) {
    return <Text type="secondary">{t('agentCatalog.dependency.connector.validating')}</Text>;
  }

  return null;
};

const ConnectorDetailPanel = ({
  connectorDetail,
  connectorDetailUsable,
  onAdd,
}: {
  connectorDetail: SwrSlice<PublishedConnectorDetail | null>;
  connectorDetailUsable: boolean;
  onAdd: () => void;
}) => {
  const { t } = useTranslation('admin');

  return (
    <DetailFetchBody
      data={connectorDetail.data}
      error={connectorDetail.error}
      isLoading={connectorDetail.isLoading}
      loading={<LoadingHint />}
      errorNode={
        <Alert
          showIcon
          action={<RetryAction mutate={connectorDetail.mutate} />}
          message={t('agentCatalog.dependency.connector.loadError')}
          type="error"
        />
      }
      unresolvable={
        <Alert
          showIcon
          message={t('agentCatalog.dependency.connector.unresolvable')}
          type="warning"
        />
      }
    >
      {(detail) => (
        <Flexbox horizontal align="center" gap={8}>
          <Text type="secondary">
            {t('agentCatalog.dependency.connector.toolsAvailable', {
              count: allowedConnectorToolKeys(detail).length,
            })}
          </Text>
          {/* Add is disabled while the detail is revalidating — never author from a stale snapshot. */}
          <Button disabled={!connectorDetailUsable} type="primary" onClick={onAdd}>
            {t('agentCatalog.dependency.connector.addAction')}
          </Button>
          {connectorDetail.isValidating ? <RevalidatingHint /> : null}
        </Flexbox>
      )}
    </DetailFetchBody>
  );
};

export const ConnectorDependencyField = ({
  connectorDetail,
  connectorDetailUsable,
  connectorId,
  connectorOptions,
  connectorRefDetails,
  connectors,
  connectorsListUsable,
  connectorsSettled,
  editable,
  enabled,
  onAdd,
  onRemove,
  onSelectConnector,
  onUpdateExisting,
  staleConnectors,
  value,
}: ConnectorDependencyFieldProps) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={8}>
      <Text as="h4" fontSize={14} weight={600}>
        {t('agentCatalog.dependency.connector.title')}
      </Text>

      <ConnectorValidationBanner
        connectorRefDetails={connectorRefDetails}
        connectorsSettled={connectorsSettled}
        enabled={enabled}
        hasRefs={value.length > 0}
      />

      {connectors.error ? (
        <Alert
          showIcon
          action={<RetryAction mutate={connectors.mutate} />}
          message={t('agentCatalog.dependency.connector.loadError')}
          type="error"
        />
      ) : (
        <Flexbox gap={8}>
          {value.length === 0 ? (
            <Text type="secondary">{t('agentCatalog.dependency.connector.empty')}</Text>
          ) : (
            value.map((connector) => (
              <Flexbox
                horizontal
                align="center"
                gap={8}
                justify="space-between"
                key={connector.connectorKey}
              >
                <Flexbox gap={2}>
                  <Flexbox horizontal align="center" gap={8}>
                    <Tag>{connector.connectorKey}</Tag>
                    <Text type="secondary">
                      {connector.allowedToolKeys.length}{' '}
                      {t('agentCatalog.dependency.connector.toolsLabel')}
                    </Text>
                    {staleConnectors.includes(connector.connectorKey) ? (
                      <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                    ) : null}
                  </Flexbox>
                </Flexbox>
                {editable ? (
                  <Flexbox horizontal gap={8}>
                    <Button
                      disabled={!connectorsListUsable}
                      size="small"
                      onClick={() => {
                        if (!connectorsListUsable) return; // never re-select from a stale list
                        onUpdateExisting(connector.connectorKey);
                      }}
                    >
                      {t('agentCatalog.dependency.connector.update')}
                    </Button>
                    <Button size="small" onClick={() => onRemove(connector.connectorKey)}>
                      {t('agentCatalog.dependency.connector.remove')}
                    </Button>
                  </Flexbox>
                ) : null}
              </Flexbox>
            ))
          )}

          {editable ? (
            <Flexbox gap={8}>
              <Select
                aria-label={t('agentCatalog.dependency.connector.add')}
                disabled={!connectorsListUsable}
                options={connectorOptions}
                value={connectorId}
                placeholder={
                  connectors.isLoading
                    ? t('agentCatalog.dependency.loading')
                    : t('agentCatalog.dependency.connector.add')
                }
                onChange={(next) => {
                  // Never mutate the selection from a stale/errored/revalidating connector list.
                  if (!connectorsListUsable) return;
                  onSelectConnector(next as string | undefined);
                }}
              />
              {connectors.isValidating && connectors.data ? <RevalidatingHint /> : null}
              {connectorId ? (
                <ConnectorDetailPanel
                  connectorDetail={connectorDetail}
                  connectorDetailUsable={connectorDetailUsable}
                  onAdd={onAdd}
                />
              ) : null}
            </Flexbox>
          ) : null}
        </Flexbox>
      )}
    </Flexbox>
  );
};
