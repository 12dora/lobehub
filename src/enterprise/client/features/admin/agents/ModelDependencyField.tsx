'use client';

import type { PlatformAgentModelDependencyRef } from '@lobechat/types';
import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
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

interface SwrSlice<T> {
  data?: T;
  error?: unknown;
  isLoading?: boolean;
  isValidating?: boolean;
  mutate: () => Promise<unknown>;
}

export interface ModelDependencyFieldProps {
  displayModelStale: boolean;
  editable: boolean;
  model: PlatformAgentModelDependencyRef | null;
  onChooseModel: (modelKey: string | undefined) => void;
  onChooseProvider: (providerId: string | undefined) => void;
  providerId: string | undefined;
  providers: SwrSlice<PublishedProviderSummary[]>;
  providersUsable: boolean;
  source: SwrSlice<ResolvedProviderModelSource | null>;
  sourceSettled: boolean;
}

export const ModelDependencyField = ({
  displayModelStale,
  editable,
  model,
  onChooseModel,
  onChooseProvider,
  providerId,
  providers,
  providersUsable,
  source,
  sourceSettled,
}: ModelDependencyFieldProps) => {
  const { t } = useTranslation('admin');

  return (
    <Flexbox gap={8}>
      <Text as="h4" fontSize={14} weight={600}>
        {t('agentCatalog.dependency.model.title')}
      </Text>
      <CatalogListBody
        empty={<Alert showIcon message={t('agentCatalog.dependency.model.empty')} type="warning" />}
        error={providers.error}
        isEmpty={Boolean(providers.data && providers.data.length === 0)}
        isLoading={providers.isLoading}
        loading={<LoadingHint />}
        errorNode={
          <Alert
            showIcon
            action={<RetryAction mutate={providers.mutate} />}
            message={t('agentCatalog.dependency.model.loadError')}
            type="error"
          />
        }
      >
        <Flexbox gap={12}>
          <Flexbox gap={6}>
            <FieldLabel>{t('agentCatalog.dependency.model.provider')}</FieldLabel>
            <Select
              aria-label={t('agentCatalog.dependency.model.provider')}
              disabled={!editable || !providersUsable}
              placeholder={t('agentCatalog.dependency.model.providerPlaceholder')}
              value={providerId}
              options={(providers.data ?? []).map((provider) => ({
                label: `${provider.displayName} (${provider.providerKey})`,
                value: provider.id,
              }))}
              onChange={(value) => onChooseProvider(value as string | undefined)}
            />
            {providers.isValidating && providers.data ? <RevalidatingHint /> : null}
          </Flexbox>

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
                <Flexbox gap={6}>
                  <FieldLabel>{t('agentCatalog.dependency.model.model')}</FieldLabel>
                  <Select
                    aria-label={t('agentCatalog.dependency.model.model')}
                    disabled={!editable || !sourceSettled}
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
                </Flexbox>
              )}
            </DetailFetchBody>
          ) : null}

          {model ? (
            <Block padding={12} variant="outlined">
              <Flexbox gap={2}>
                <Flexbox horizontal align="center" gap={8}>
                  <Text>
                    {model.providerKey}/{model.modelKey}
                  </Text>
                  {displayModelStale ? (
                    <Tag color="warning">{t('agentCatalog.dependency.stale')}</Tag>
                  ) : null}
                  {source.isValidating && source.data ? <RevalidatingHint /> : null}
                </Flexbox>
              </Flexbox>
            </Block>
          ) : (
            <Text type="danger">{t('agentCatalog.dependency.model.required')}</Text>
          )}
        </Flexbox>
      </CatalogListBody>
    </Flexbox>
  );
};
