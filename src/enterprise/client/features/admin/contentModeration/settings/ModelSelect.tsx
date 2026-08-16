'use client';

import { Input, Select } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModerationCatalogModel } from '../types';

export interface ModelSelectProps {
  catalog: readonly ModerationCatalogModel[];
  disabled?: boolean;
  onChange: (value: { model: string; provider: string } | null) => void;
  value: { model: string; provider: string } | null;
}

/**
 * Provider → model picker over the published platform-hosted catalog.
 *
 * When the server does not ship a catalog (older build, or the admin's role cannot read the
 * AI catalog) the control degrades to two free-text fields rather than disappearing — the
 * server validates the pair on save anyway.
 */
const ModelSelect = memo<ModelSelectProps>(({ catalog, disabled, onChange, value }) => {
  const { t } = useTranslation('admin');

  const providers = useMemo(() => {
    const seen = new Map<string, string>();
    for (const item of catalog) {
      if (!seen.has(item.provider)) seen.set(item.provider, item.providerLabel ?? item.provider);
    }
    return [...seen.entries()].map(([provider, label]) => ({ label, value: provider }));
  }, [catalog]);

  const models = useMemo(
    () =>
      catalog
        .filter((item) => item.provider === value?.provider)
        .map((item) => ({ label: item.label ?? item.model, value: item.model })),
    [catalog, value?.provider],
  );

  if (catalog.length === 0) {
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <Input
          disabled={disabled}
          placeholder={t('contentModeration.settings.providerPlaceholder')}
          style={{ width: 200 }}
          value={value?.provider ?? ''}
          onChange={(event) =>
            onChange(
              event.target.value || value?.model
                ? { model: value?.model ?? '', provider: event.target.value }
                : null,
            )
          }
        />
        <Input
          disabled={disabled}
          placeholder={t('contentModeration.settings.modelPlaceholder')}
          style={{ width: 240 }}
          value={value?.model ?? ''}
          onChange={(event) =>
            onChange(
              event.target.value || value?.provider
                ? { model: event.target.value, provider: value?.provider ?? '' }
                : null,
            )
          }
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <Select
        allowClear
        disabled={disabled}
        options={providers}
        placeholder={t('contentModeration.settings.providerPlaceholder')}
        style={{ width: 200 }}
        value={value?.provider ?? undefined}
        onChange={(next) => {
          const provider = typeof next === 'string' ? next : '';
          if (!provider) {
            onChange(null);
            return;
          }
          // Changing provider invalidates the model — never keep a pair that cannot exist.
          const first = catalog.find((item) => item.provider === provider);
          onChange({ model: first?.model ?? '', provider });
        }}
      />
      <Select
        disabled={disabled || !value?.provider}
        options={models}
        placeholder={t('contentModeration.settings.modelPlaceholder')}
        style={{ width: 260 }}
        value={value?.model || undefined}
        onChange={(next) => {
          if (!value?.provider) return;
          onChange({ model: typeof next === 'string' ? next : '', provider: value.provider });
        }}
      />
    </div>
  );
});

ModelSelect.displayName = 'ModerationModelSelect';

export default ModelSelect;
