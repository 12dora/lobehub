'use client';

import type { PlatformAgentModelDependencyRef } from '@lobechat/types';
import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, Input, Select } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { useTranslation } from 'react-i18next';

import type { PublishedProviderSummary, ResolvedProviderModelSource } from './dependencyCatalog';
import {
  CatalogListBody,
  DetailFetchBody,
  FieldLabel,
  LoadingHint,
  RetryAction,
  RevalidatingHint,
} from './dependencyEditorShared';

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  `,
  /** Provider and model are one choice made in two steps — never two stacked, unrelated rows. */
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;

    @media (width <= 640px) {
      grid-template-columns: 1fr;
    }
  `,
}));

/** Where an admin publishes the providers this picker reads from. */
const PROVIDER_CATALOG_PATH = '/admin/ai/providers';

const PROVIDER_SEARCH_ID = 'admin-agent-editor-provider-search';
const PROVIDER_SELECT_ID = 'admin-agent-editor-provider';
const MODEL_SELECT_ID = 'admin-agent-editor-model';

interface SwrSlice<T> {
  data?: T;
  error?: unknown;
  isLoading?: boolean;
  isValidating?: boolean;
  mutate: () => Promise<unknown>;
  truncated?: boolean;
}

export interface ModelDependencyFieldProps {
  displayModelStale: boolean;
  editable: boolean;
  /** Set when the surrounding form section already carries the "Model" heading. */
  hideTitle?: boolean;
  model: PlatformAgentModelDependencyRef | null;
  onChooseModel: (modelKey: string | undefined) => void;
  onChooseProvider: (providerId: string | undefined) => void;
  /** Debounced by the owner into the catalog SWR key — this is a server search, not a local filter. */
  onProviderSearchChange: (query: string) => void;
  providerId: string | undefined;
  providers: SwrSlice<PublishedProviderSummary[]>;
  providerSearch: string;
  providersUsable: boolean;
  source: SwrSlice<ResolvedProviderModelSource | null>;
  sourceSettled: boolean;
}

export const ModelDependencyField = ({
  displayModelStale,
  editable,
  hideTitle = false,
  model,
  onChooseModel,
  onChooseProvider,
  onProviderSearchChange,
  providerId,
  providers,
  providerSearch,
  providersUsable,
  source,
  sourceSettled,
}: ModelDependencyFieldProps) => {
  const { t } = useTranslation('admin');

  // The Select's own search only filters the page already loaded. Once the server says there is
  // more beyond it, the admin needs a real query — so the box appears exactly then, and stays for
  // as long as a query is active (a narrowing query un-truncates the page).
  const serverSearchable = Boolean(providers.truncated) || providerSearch.length > 0;

  return (
    <Flexbox gap={8}>
      {hideTitle ? null : (
        <Text as="h4" fontSize={14} weight={600}>
          {t('agentCatalog.dependency.model.title')}
        </Text>
      )}
      <CatalogListBody
        error={providers.error}
        isEmpty={Boolean(providers.data && providers.data.length === 0)}
        isLoading={providers.isLoading}
        loading={<LoadingHint />}
        empty={
          // A platform with no published provider is a dead end for this form — say where to go.
          <Alert
            showIcon
            message={t('agentCatalog.dependency.model.empty')}
            type="warning"
            action={
              <Button href={PROVIDER_CATALOG_PATH} rel="noreferrer" size="small" target="_blank">
                {t('agentCatalog.dependency.model.emptyAction')}
              </Button>
            }
          />
        }
        errorNode={
          <Alert
            showIcon
            action={<RetryAction mutate={providers.mutate} />}
            message={t('agentCatalog.dependency.model.loadError')}
            type="error"
          />
        }
      >
        <Flexbox gap={8}>
          <div className={styles.grid}>
            <div className={styles.field}>
              <FieldLabel required htmlFor={PROVIDER_SELECT_ID}>
                {t('agentCatalog.dependency.model.provider')}
              </FieldLabel>
              {serverSearchable ? (
                <Input
                  aria-label={t('agentCatalog.dependency.model.providerSearch')}
                  disabled={!editable}
                  id={PROVIDER_SEARCH_ID}
                  placeholder={t('agentCatalog.dependency.model.providerSearchPlaceholder')}
                  type="search"
                  value={providerSearch}
                  onChange={(event) => onProviderSearchChange(event.target.value)}
                />
              ) : null}
              <Select
                required
                showSearch
                aria-label={t('agentCatalog.dependency.model.provider')}
                disabled={!editable || !providersUsable}
                id={PROVIDER_SELECT_ID}
                placeholder={t('agentCatalog.dependency.model.providerPlaceholder')}
                value={providerId}
                options={(providers.data ?? []).map((provider) => ({
                  label: `${provider.displayName} (${provider.providerKey})`,
                  value: provider.id,
                }))}
                onChange={(value) => onChooseProvider(value as string | undefined)}
              />
              {providers.truncated ? (
                <Text type="secondary">{t('agentCatalog.dependency.catalogTruncated')}</Text>
              ) : null}
              {providers.isValidating && providers.data ? <RevalidatingHint /> : null}
            </div>

            <div className={styles.field}>
              <FieldLabel
                required
                help={t('agentCatalog.dependency.model.required')}
                htmlFor={MODEL_SELECT_ID}
              >
                {t('agentCatalog.dependency.model.model')}
              </FieldLabel>
              {providerId ? (
                <DetailFetchBody
                  data={source.data}
                  error={source.error}
                  isLoading={source.isLoading}
                  loading={<LoadingHint />}
                  errorNode={
                    <Alert
                      showIcon
                      action={<RetryAction mutate={source.mutate} />}
                      message={t('agentCatalog.dependency.model.loadError')}
                      type="error"
                    />
                  }
                  unresolvable={
                    <Alert
                      showIcon
                      message={t('agentCatalog.dependency.model.unresolvable')}
                      type="warning"
                    />
                  }
                >
                  {(resolved) => (
                    <Select
                      required
                      showSearch
                      aria-label={t('agentCatalog.dependency.model.model')}
                      disabled={!editable || !sourceSettled}
                      id={MODEL_SELECT_ID}
                      placeholder={t('agentCatalog.dependency.model.modelPlaceholder')}
                      value={model?.modelKey}
                      options={resolved.chatModels.map((option) => ({
                        label: option.displayName
                          ? `${option.displayName} (${option.modelKey})`
                          : option.modelKey,
                        value: option.modelKey,
                      }))}
                      onChange={(value) => onChooseModel(value as string | undefined)}
                    />
                  )}
                </DetailFetchBody>
              ) : (
                // Held open rather than hidden, so picking a provider never shifts the row.
                <Select
                  disabled
                  required
                  aria-label={t('agentCatalog.dependency.model.model')}
                  id={MODEL_SELECT_ID}
                  placeholder={t('agentCatalog.dependency.model.modelPlaceholder')}
                />
              )}
            </div>
          </div>

          {/* What was chosen, echoed once. Why it is needed lives in the label's help. */}
          {model ? (
            <Flexbox horizontal align="center" gap={8} wrap="wrap">
              <Tag>
                {model.providerKey}/{model.modelKey}
              </Tag>
              {displayModelStale ? (
                <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
              ) : null}
              {source.isValidating && source.data ? <RevalidatingHint /> : null}
            </Flexbox>
          ) : null}
        </Flexbox>
      </CatalogListBody>
    </Flexbox>
  );
};
