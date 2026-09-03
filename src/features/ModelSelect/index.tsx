import { ModelIcon } from '@lobehub/icons';
import { Flexbox, Tag, Text, Tooltip, TooltipGroup } from '@lobehub/ui';
import { Select, type SelectProps, Switch } from '@lobehub/ui/base-ui';
import { createStaticStyles } from 'antd-style';
import { type ReactNode } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { message } from '@/components/AntdStaticMethods';
import { ModelItemRender, ProviderItemRender, TAG_CLASSNAME } from '@/components/ModelSelect';
import { useManagedResource } from '@/features/ManagedResources';
// Scoped hook: defaults to the user singleton outside AdminProviderSettingsStoreProvider;
// under admin platform pages it reads the published platform catalog.
import { aiProviderSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';
import { type EnabledProviderWithModels } from '@/types/aiProvider';

import { resolveEnableTargetProviderId, resolveStaleModelState } from './resolveStaleModelState';

const prefixCls = 'ant';

/**
 * Marks the popup-only part (explanatory hint) of the stale-model option so the
 * trigger can hide it, mirroring how ability tags are hidden via TAG_CLASSNAME.
 */
const STALE_EXTRA_CLASSNAME = 'lobe-model-select-stale-extra';

/**
 * Marks the stale-status Tag so the popup can hide it — inside the open list the
 * status is conveyed by the enable toggle (notEnabled), while the closed
 * trigger keeps showing the Tag.
 */
const STALE_TAG_CLASSNAME = 'lobe-model-select-stale-tag';

const styles = createStaticStyles(({ css, cssVar }) => ({
  popup: css`
    width: max(360px, var(--anchor-width));

    &.${prefixCls}-select-dropdown .${prefixCls}-select-item-option-grouped {
      padding-inline-start: 12px;
    }

    /* !important: the Tag's own class rule wins the cascade over this
     * descendant selector, so a plain display: none never applies. */
    .${STALE_TAG_CLASSNAME} {
      display: none !important;
    }
  `,
  select: css`
    /* The base-ui Select applies className to the trigger root while the popup is
     * portaled away, so scoping directly under this class hides the popup-only bits
     * (ability tags / stale hint) from the closed trigger without touching the list. */
    .${TAG_CLASSNAME} {
      display: none;
    }

    .${STALE_EXTRA_CLASSNAME} {
      display: none;
    }
  `,
  staleHint: css`
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextTertiary};
    white-space: normal;
  `,
}));

interface ModelOption {
  abilities?: Record<string, boolean>;
  id: string;
  label: ReactNode;
  provider: string;
  value: string;
}

interface ModelSelectProps extends Pick<
  SelectProps,
  'disabled' | 'loading' | 'size' | 'style' | 'variant'
> {
  defaultValue?: { model: string; provider?: string };
  initialWidth?: boolean;
  modelType?: 'chat' | 'embedding';
  onChange?: (props: { model: string; provider: string }) => void;
  popupWidth?: number;
  requiredAbilities?: (keyof EnabledProviderWithModels['children'][number]['abilities'])[];
  showAbility?: boolean;
  value?: { model: string; provider?: string };
}

const ModelSelect = memo<ModelSelectProps>(
  ({
    value,
    onChange,
    showAbility: _showAbility = true,
    requiredAbilities,
    loading,
    disabled,
    size,
    style,
    variant,
    initialWidth = false,
    popupWidth,
    modelType = 'chat',
  }) => {
    const { t } = useTranslation('components');
    const [enabling, setEnabling] = useState(false);
    const { blocked: aiModelMutationBlocked } = useManagedResource('aiModels');
    const { blocked: aiProviderMutationBlocked } = useManagedResource('aiProviders');
    /**
     * Only the admin adapter implements `syncUpstreamModels`, so this is the scoped store
     * saying "I administer the platform catalog" — the same signal `useSyncUpstreamModels`
     * reads. It matters here because this picker also renders inside the admin catalog store
     * (`ServiceModelSettingsPage`), where the two toggles below dispatch to
     * `admin.ai{Models,Providers}.applyImmediate`; the managed-resource policy freezes the
     * MEMBERS' overlay and its server-side mutation guard does not cover those admin paths.
     * Without the exemption an admin fixing a platform default that points at a disabled model
     * was shown the member "managed" state instead of the inline enable action.
     */
    const administersPlatformCatalog = useAiInfraStore((s) => s.supportsUpstreamSync);
    const canEnableStaleModel =
      administersPlatformCatalog || (!aiModelMutationBlocked && !aiProviderMutationBlocked);
    const enabledList = useAiInfraStore((s) =>
      modelType === 'embedding'
        ? aiProviderSelectors.enabledEmbeddingModelList(s)
        : s.enabledChatModelList || [],
    );
    const builtinAiModelList = useAiInfraStore((s) => s.builtinAiModelList);
    const enabledAiProviders = useAiInfraStore((s) => s.enabledAiProviders);
    const isInitAiProviderRuntimeState = useAiInfraStore((s) => s.isInitAiProviderRuntimeState);
    const toggleProviderModelEnabled = useAiInfraStore((s) => s.toggleProviderModelEnabled);
    const toggleProviderEnabled = useAiInfraStore((s) => s.toggleProviderEnabled);

    const options = useMemo<SelectProps['options']>(() => {
      const getChatModels = (provider: EnabledProviderWithModels) => {
        const models =
          requiredAbilities && requiredAbilities.length > 0
            ? provider.children.filter((model) =>
                requiredAbilities.every((ability) => Boolean(model.abilities?.[ability])),
              )
            : provider.children;

        return models.map((model) => ({
          ...model,
          label: <ModelItemRender {...model} {...model.abilities} showInfoTag={false} />,
          provider: provider.id,
          value: `${provider.id}/${model.id}`,
        }));
      };

      if (enabledList.length === 1) {
        const provider = enabledList[0];

        return getChatModels(provider);
      }

      return enabledList
        .map((provider) => {
          const opts = getChatModels(provider);
          if (opts.length === 0) return undefined;

          return {
            label: (
              <ProviderItemRender
                logo={provider.logo}
                name={provider.name}
                provider={provider.id}
                source={provider.source}
              />
            ),
            options: opts,
          };
        })
        .filter(Boolean) as SelectProps['options'];
    }, [enabledList, requiredAbilities]);

    const staleState = useMemo(() => {
      // Before the runtime state hydrates, the store lists are empty and any valid
      // persisted value would resolve to `removed` — treat pre-init as unknown so the
      // first paint never flashes an "Unavailable" warning.
      if (!isInitAiProviderRuntimeState) return;

      return resolveStaleModelState(value, {
        builtinAiModelList,
        enabledList,
        modelType,
      });
    }, [builtinAiModelList, enabledList, isInitAiProviderRuntimeState, modelType, value]);

    const handleEnable = useCallback(async () => {
      // Prefer the provider the selection is persisted under so every surface
      // referencing `${provider}/${model}` recovers at once; the builtin-bank
      // provider is only a fallback for a persisted provider that no longer exists.
      const providerId = resolveEnableTargetProviderId(value, {
        enabledAiProviders,
        enabledList,
        metaProviderId: staleState?.meta?.providerId,
      });
      if (!canEnableStaleModel || !providerId || !value) return;

      setEnabling(true);
      try {
        // Enabling only the model row is a silent no-op when the owning provider is
        // disabled — the picker keeps building options from enabled providers. Enable
        // the provider first so the remedy actually makes the selection resolvable
        // (idempotent when the provider is enabled but absent from this typed list).
        if (!enabledList.some((provider) => provider.id === providerId)) {
          await toggleProviderEnabled(providerId, true);
        }
        await toggleProviderModelEnabled({
          enabled: true,
          id: value.model,
          providerId,
          type: modelType,
        });
        // Realign the selection when it pointed at a different provider, so the now
        // enabled model resolves as a valid option instead of staying stale.
        if (providerId !== value.provider) onChange?.({ model: value.model, provider: providerId });
      } catch {
        message.error(t('ModelSelect.staleModel.notEnabled.actionFailed'));
      } finally {
        setEnabling(false);
      }
    }, [
      canEnableStaleModel,
      enabledAiProviders,
      enabledList,
      modelType,
      onChange,
      staleState,
      t,
      toggleProviderEnabled,
      toggleProviderModelEnabled,
      value,
    ]);

    const finalOptions = useMemo<SelectProps['options']>(() => {
      if (!staleState || !value) return options;

      const { meta, status } = staleState;

      const currentOption = {
        __stale: true,
        disabled: true,
        label: (
          <Flexbox gap={4}>
            <Flexbox horizontal align={'center'} gap={8}>
              <ModelIcon model={value.model} size={20} />
              <Text ellipsis style={{ fontSize: 14 }}>
                {meta?.displayName || value.model}
              </Text>
              <Tooltip
                title={t(
                  status === 'notEnabled' && !canEnableStaleModel
                    ? 'ModelSelect.staleModel.notEnabled.managedTooltip'
                    : `ModelSelect.staleModel.${status}.tooltip`,
                )}
              >
                <Tag
                  className={STALE_TAG_CLASSNAME}
                  color={status === 'removed' ? 'warning' : undefined}
                  size={'small'}
                  style={{ cursor: 'default', flex: 'none' }}
                >
                  {t(`ModelSelect.staleModel.${status}.tag`)}
                </Tag>
              </Tooltip>
              {status === 'notEnabled' && canEnableStaleModel && (
                <>
                  <span className={STALE_EXTRA_CLASSNAME} style={{ flex: 1 }} />
                  {/* The wrapper re-enables pointer events (the disabled option row
                   * suppresses them) and stops propagation so toggling never counts
                   * as selecting the row. */}
                  <span
                    className={STALE_EXTRA_CLASSNAME}
                    style={{ flex: 'none', pointerEvents: 'auto' }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                    }}
                  >
                    <Switch
                      aria-label={t('ModelSelect.staleModel.notEnabled.action')}
                      checked={false}
                      loading={enabling}
                      size={'small'}
                      onChange={() => {
                        void handleEnable();
                      }}
                    />
                  </span>
                </>
              )}
            </Flexbox>
            <span className={`${STALE_EXTRA_CLASSNAME} ${styles.staleHint}`}>
              {t(
                status === 'notEnabled' && !canEnableStaleModel
                  ? 'ModelSelect.staleModel.notEnabled.managedHint'
                  : `ModelSelect.staleModel.${status}.hint`,
              )}
            </span>
          </Flexbox>
        ),
        value: `${value.provider}/${value.model}`,
      };

      return [
        {
          label: t('ModelSelect.staleModel.current'),
          options: [currentOption],
        },
        ...(options ?? []),
      ] as SelectProps['options'];
    }, [canEnableStaleModel, enabling, handleEnable, options, staleState, t, value]);

    return (
      <TooltipGroup>
        <Select
          className={styles.select}
          defaultValue={`${value?.provider}/${value?.model}`}
          disabled={disabled}
          loading={loading || enabling}
          options={finalOptions}
          popupClassName={styles.popup}
          popupMatchSelectWidth={popupWidth === undefined ? false : popupWidth}
          size={size}
          value={`${value?.provider}/${value?.model}`}
          variant={variant}
          optionRender={(option) => {
            if ((option as unknown as { __stale?: boolean }).__stale) return option.label;

            return (
              <ModelItemRender
                {...(option as ModelOption)}
                {...(option as ModelOption).abilities}
                showInfoTag={false}
              />
            );
          }}
          style={{
            minWidth: 200,
            width: initialWidth ? 'initial' : undefined,
            ...style,
          }}
          onChange={(next, option) => {
            const model = next.split('/').slice(1).join('/');
            onChange?.({ model, provider: (option as unknown as ModelOption).provider });
          }}
        />
      </TooltipGroup>
    );
  },
);

export default ModelSelect;
