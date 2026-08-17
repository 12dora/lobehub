'use client';

import { InputNumber, Select } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_SYSTEM_ROLES } from '@/const/platform/roles';

import { moderationStyles as styles } from '../../styles';
import { modelScopeKey, type ModerationCatalogModel } from '../../types';
import type { ModerationConfigView } from '../draft';
import ExemptUserPicker from '../ExemptUserPicker';
import Field from '../Field';
import SettingsSection from '../SettingsSection';

export interface ScopeSectionProps {
  canSearchUsers: boolean;
  catalog: readonly ModerationCatalogModel[];
  config: ModerationConfigView;
  disabled: boolean;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
  /** Assignable role names from the server; falls back to the built-in system roles. */
  roles: readonly string[];
}

const MODEL_FILTER_TYPES = ['all', 'include', 'exclude'] as const;

const ScopeSection = memo<ScopeSectionProps>(
  ({ canSearchUsers, catalog, config, disabled, onPatch, roles }) => {
    const { t } = useTranslation('admin');

    const roleOptions = useMemo(() => {
      const names = new Set<string>([
        ...roles,
        ...Object.values(PLATFORM_SYSTEM_ROLES),
        ...config.scope.exemptRoles,
      ]);
      return [...names].map((name) => ({ label: name, value: name }));
    }, [config.scope.exemptRoles, roles]);

    const modelOptions = useMemo(
      () =>
        catalog.map((item) => ({
          label: `${item.providerLabel ?? item.provider} / ${item.label ?? item.model}`,
          value: modelScopeKey(item.provider, item.model),
        })),
      [catalog],
    );

    const scope = config.scope;

    return (
      <SettingsSection
        description={t('contentModeration.settings.scope.desc')}
        title={t('contentModeration.settings.scope.title')}
      >
        <div className={styles.fieldGrid}>
          <Field
            hint={t('contentModeration.settings.scope.exemptRolesHint')}
            label={t('contentModeration.settings.scope.exemptRoles')}
          >
            <Select
              disabled={disabled}
              mode="multiple"
              options={roleOptions}
              placeholder={t('contentModeration.settings.scope.exemptRolesPlaceholder')}
              style={{ width: '100%' }}
              value={scope.exemptRoles}
              onChange={(next) =>
                onPatch({ scope: { ...scope, exemptRoles: Array.isArray(next) ? next : [] } })
              }
            />
          </Field>

          <Field
            hint={t('contentModeration.settings.scope.exemptUsersHint')}
            label={t('contentModeration.settings.scope.exemptUsers')}
          >
            <ExemptUserPicker
              disabled={disabled}
              enabled={canSearchUsers}
              value={scope.exemptUserIds}
              onChange={(userIds) => onPatch({ scope: { ...scope, exemptUserIds: userIds } })}
            />
          </Field>

          <Field
            hint={t('contentModeration.settings.scope.modelFilterHint')}
            label={t('contentModeration.settings.scope.modelFilter')}
          >
            <div className={styles.formRow}>
              <Select
                disabled={disabled}
                style={{ width: 140 }}
                value={scope.modelFilter.type}
                options={MODEL_FILTER_TYPES.map((value) => ({
                  label: t(`contentModeration.settings.scope.modelFilterType.${value}` as never),
                  value,
                }))}
                onChange={(next) =>
                  onPatch({
                    scope: {
                      ...scope,
                      modelFilter: {
                        models: next === 'all' ? [] : scope.modelFilter.models,
                        type: (next as 'all' | 'exclude' | 'include') ?? 'all',
                      },
                    },
                  })
                }
              />
              {scope.modelFilter.type === 'all' ? null : (
                <Select
                  disabled={disabled}
                  mode={modelOptions.length > 0 ? 'multiple' : 'tags'}
                  options={modelOptions}
                  placeholder={t('contentModeration.settings.scope.modelsPlaceholder')}
                  style={{ flex: 1, minWidth: 200 }}
                  value={scope.modelFilter.models}
                  onChange={(next) =>
                    onPatch({
                      scope: {
                        ...scope,
                        modelFilter: {
                          ...scope.modelFilter,
                          models: Array.isArray(next) ? next : [],
                        },
                      },
                    })
                  }
                />
              )}
            </div>
          </Field>

          <Field
            hint={t('contentModeration.settings.scope.sampleRateHint')}
            label={t('contentModeration.settings.scope.sampleRate')}
          >
            <InputNumber
              disabled={disabled}
              max={100}
              min={0}
              step={1}
              style={{ width: 140 }}
              value={scope.sampleRate}
              onChange={(next) => onPatch({ scope: { ...scope, sampleRate: Number(next ?? 0) } })}
            />
          </Field>
        </div>
      </SettingsSection>
    );
  },
);

ScopeSection.displayName = 'ModerationScopeSection';

export default ScopeSection;
