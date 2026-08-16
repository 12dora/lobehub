'use client';

import type { PlatformAgentConnectorDependencyRef } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Input, Select } from '@lobehub/ui/base-ui';
import { useTranslation } from 'react-i18next';

import { type PublishedConnectorDetail, type PublishedConnectorSummary } from './dependencyCatalog';
import {
  DetailFetchBody,
  FieldLabel,
  LoadingHint,
  RetryAction,
  RevalidatingHint,
} from './dependencyEditorShared';

const CONNECTOR_SEARCH_ID = 'admin-agent-editor-connector-search';
const CONNECTOR_SELECT_ID = 'admin-agent-editor-connectors';

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
  truncated?: boolean;
}

export interface ConnectorDependencyFieldProps {
  connectorDetail: SwrSlice<PublishedConnectorDetail | null>;
  connectorOptions: SelectOption[];
  connectorRefDetails: SwrSlice<unknown>;
  connectors: SwrSlice<PublishedConnectorSummary[]>;
  connectorSearch: string;
  connectorsListUsable: boolean;
  connectorsSettled: boolean;
  editable: boolean;
  enabled: boolean;
  /** The whole selection after a pick or an unpick — one control, one change. */
  onChange: (connectorIds: string[]) => void;
  onConnectorSearchChange: (query: string) => void;
  onRemove: (connectorKey: string) => void;
  onUpdateExisting: (connectorKey: string) => void;
  /** Picks whose exact detail is still resolving, in pick order — none is authored yet. */
  pendingConnectorIds: string[];
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

/**
 * A pick is not a dependency until its exact published detail (revision + checksum + tools) has
 * settled, so the wait — and every way it can fail — is stated here instead of silently dropping
 * the pick.
 */
const ConnectorPendingPanel = ({
  connectorDetail,
}: {
  connectorDetail: SwrSlice<PublishedConnectorDetail | null>;
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
      {() => (connectorDetail.isValidating ? <RevalidatingHint /> : <LoadingHint />)}
    </DetailFetchBody>
  );
};

export const ConnectorDependencyField = ({
  connectorDetail,
  connectorOptions,
  connectorRefDetails,
  connectorSearch,
  connectors,
  connectorsListUsable,
  connectorsSettled,
  editable,
  enabled,
  onChange,
  onConnectorSearchChange,
  onRemove,
  onUpdateExisting,
  pendingConnectorIds,
  staleConnectors,
  value,
}: ConnectorDependencyFieldProps) => {
  const { t } = useTranslation('admin');

  // The picker's own search only filters the page already loaded. Once the server says there is
  // more beyond it, the admin needs a real query — so the box appears exactly then, and stays for
  // as long as a query is active (a narrowing query un-truncates the page).
  const serverSearchable = Boolean(connectors.truncated) || connectorSearch.length > 0;
  const selected = value.map((connector) => connector.connectorId);
  // EVERY pick shows as chosen while its detail resolves — a second pick made during the first
  // one's fetch must not push it out of the value. Dropping one here cancels just that authoring.
  const picked = [
    ...selected,
    ...pendingConnectorIds.filter((connectorId) => !selected.includes(connectorId)),
  ];

  return (
    <Flexbox gap={8}>
      <FieldLabel htmlFor={CONNECTOR_SELECT_ID}>
        {t('agentCatalog.dependency.connector.title')}
      </FieldLabel>

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
          {serverSearchable ? (
            <Input
              aria-label={t('agentCatalog.dependency.connector.search')}
              disabled={!editable}
              id={CONNECTOR_SEARCH_ID}
              placeholder={t('agentCatalog.dependency.connector.searchPlaceholder')}
              type="search"
              value={connectorSearch}
              onChange={(event) => onConnectorSearchChange(event.target.value)}
            />
          ) : null}
          {/* One searchable control that both picks and shows what is picked. */}
          <Select
            showSearch
            aria-label={t('agentCatalog.dependency.connector.add')}
            disabled={!editable || !connectorsListUsable}
            id={CONNECTOR_SELECT_ID}
            mode="multiple"
            options={connectorOptions}
            value={picked}
            placeholder={
              connectors.isLoading
                ? t('agentCatalog.dependency.loading')
                : t('agentCatalog.dependency.connector.add')
            }
            onChange={(next) => {
              // Never mutate the selection from a stale/errored/revalidating connector list.
              if (!connectorsListUsable) return;
              onChange(Array.isArray(next) ? (next as string[]) : []);
            }}
          />
          {connectors.truncated ? (
            <Text type="secondary">{t('agentCatalog.dependency.catalogTruncated')}</Text>
          ) : null}
          {connectors.isValidating && connectors.data ? <RevalidatingHint /> : null}
          {pendingConnectorIds.length > 0 ? (
            <ConnectorPendingPanel connectorDetail={connectorDetail} />
          ) : null}

          {/* A Connector that drifted from the published catalog blocks Save: refresh it or drop it. */}
          {value
            .filter((connector) => staleConnectors.includes(connector.connectorKey))
            .map((connector) => (
              <Flexbox
                horizontal
                align="center"
                gap={8}
                justify="space-between"
                key={connector.connectorKey}
              >
                <Flexbox horizontal align="center" gap={8}>
                  <Tag>{connector.connectorKey}</Tag>
                  <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
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
            ))}
        </Flexbox>
      )}
    </Flexbox>
  );
};
