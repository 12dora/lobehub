import type { TFunction } from 'i18next';

import type { AdminSettingsGetDraftOutput } from '@/server/enterprise/contracts/adminSettings';

export type RegistryEntry = AdminSettingsGetDraftOutput['registry'][number];

const SENSITIVE_PATH = /(?:^|\.)(?:apiKey|key|password|secret|token)(?:\.|$)/i;

export const isSensitiveSettingPath = (path: string) => SENSITIVE_PATH.test(path);

export const formatSettingValue = (params: {
  entry: RegistryEntry;
  t: TFunction<'admin'>;
  value: unknown;
}): string => {
  if (isSensitiveSettingPath(params.entry.path)) return params.t('settingsPolicy.value.redacted');
  if (params.value === undefined || params.value === null || params.value === '') {
    return params.t('settingsPolicy.value.unset');
  }
  if (params.entry.control === 'switch' && typeof params.value === 'boolean') {
    return params.t(
      params.value ? 'settingsPolicy.value.enabled' : 'settingsPolicy.value.disabled',
    );
  }
  if (params.entry.control === 'select') {
    const option = params.entry.options?.find((item) => Object.is(item.value, params.value));
    if (option) return params.t(option.labelKey as never, { defaultValue: String(option.value) });
  }
  if (typeof params.value === 'number') {
    return new Intl.NumberFormat().format(params.value);
  }
  if (typeof params.value === 'string') return params.value;
  if (typeof params.value === 'boolean') {
    return params.t(
      params.value ? 'settingsPolicy.value.enabled' : 'settingsPolicy.value.disabled',
    );
  }
  return params.t('settingsPolicy.value.complex');
};

export const formatPolicySummary = (params: {
  entry: RegistryEntry;
  mode: string;
  t: TFunction<'admin'>;
  value: unknown;
  visibility: string;
}) =>
  params.t('settingsPolicy.preview.summary', {
    mode: params.t(`settingsPolicy.mode.${params.mode}` as never, {
      defaultValue: params.mode,
    }),
    value: formatSettingValue(params),
    visibility: params.t(`settingsPolicy.visibility.${params.visibility}` as never, {
      defaultValue: params.visibility,
    }),
  });
