'use client';

import { Input, Segmented, Select } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { InfraField } from './InfraField';
import type { SandboxDraft } from './sandboxDraft';
import { infraFormStyles as styles } from './styles';

export interface SandboxFormProps {
  disabled: boolean;
  draft: SandboxDraft;
  errors: Record<string, string>;
  onPatch: (next: Partial<SandboxDraft>) => void;
}

export const SandboxForm = memo<SandboxFormProps>(({ disabled, draft, errors, onPatch }) => {
  const { t } = useTranslation('admin');

  return (
    <div className={styles.stack}>
      <InfraField label={t('systemGeneral.sandbox.fields.provider')}>
        {(field) => (
          <div aria-labelledby={field.labelId} role="group">
            <Segmented
              disabled={disabled}
              value={draft.provider}
              options={[
                { label: t('systemGeneral.sandbox.provider.local'), value: 'local' },
                { label: t('systemGeneral.sandbox.provider.market'), value: 'market' },
                { label: t('systemGeneral.sandbox.provider.onlyboxes'), value: 'onlyboxes' },
              ]}
              onChange={(next) => onPatch({ provider: next as SandboxDraft['provider'] })}
            />
          </div>
        )}
      </InfraField>

      {draft.provider === 'local' ? (
        <div className={styles.fieldGrid}>
          <InfraField
            error={errors.dockerSocket}
            hint={t('systemGeneral.sandbox.hints.dockerSocket')}
            label={t('systemGeneral.sandbox.fields.dockerSocket')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                value={draft.dockerSocket}
                onChange={(event) => onPatch({ dockerSocket: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            hint={t('systemGeneral.sandbox.hints.dockerHost')}
            label={t('systemGeneral.sandbox.fields.dockerHost')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                value={draft.dockerHost}
                onChange={(event) => onPatch({ dockerHost: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.image}
            hint={t('systemGeneral.sandbox.hints.image')}
            label={t('systemGeneral.sandbox.fields.image')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                value={draft.image}
                onChange={(event) => onPatch({ image: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            hint={t('systemGeneral.sandbox.hints.pullPolicy')}
            label={t('systemGeneral.sandbox.fields.pullPolicy')}
          >
            {(field) => (
              <Select
                {...field.control}
                disabled={disabled}
                value={draft.pullPolicy}
                options={[
                  {
                    label: t('systemGeneral.sandbox.pullPolicy.if-missing'),
                    value: 'if-missing',
                  },
                  { label: t('systemGeneral.sandbox.pullPolicy.always'), value: 'always' },
                  { label: t('systemGeneral.sandbox.pullPolicy.never'), value: 'never' },
                ]}
                onChange={(next) => onPatch({ pullPolicy: next as SandboxDraft['pullPolicy'] })}
              />
            )}
          </InfraField>
          <InfraField
            hint={t('systemGeneral.sandbox.hints.network')}
            label={t('systemGeneral.sandbox.fields.network')}
          >
            {(field) => (
              <div aria-labelledby={field.labelId} role="group">
                <Segmented
                  disabled={disabled}
                  value={draft.network}
                  options={[
                    { label: t('systemGeneral.sandbox.network.bridge'), value: 'bridge' },
                    { label: t('systemGeneral.sandbox.network.none'), value: 'none' },
                  ]}
                  onChange={(next) => onPatch({ network: next as SandboxDraft['network'] })}
                />
              </div>
            )}
          </InfraField>
          <InfraField error={errors.memoryMb} label={t('systemGeneral.sandbox.fields.memoryMb')}>
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.memoryMb}
                onChange={(event) => onPatch({ memoryMb: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField error={errors.pidsLimit} label={t('systemGeneral.sandbox.fields.pidsLimit')}>
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.pidsLimit}
                onChange={(event) => onPatch({ pidsLimit: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField error={errors.cpus} label={t('systemGeneral.sandbox.fields.cpus')}>
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="decimal"
                value={draft.cpus}
                onChange={(event) => onPatch({ cpus: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField error={errors.timeoutMs} label={t('systemGeneral.sandbox.fields.timeoutMs')}>
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.timeoutMs}
                onChange={(event) => onPatch({ timeoutMs: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.maxOutputBytes}
            label={t('systemGeneral.sandbox.fields.maxOutputBytes')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.maxOutputBytes}
                onChange={(event) => onPatch({ maxOutputBytes: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.idleTtlSec}
            label={t('systemGeneral.sandbox.fields.idleTtlSec')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.idleTtlSec}
                onChange={(event) => onPatch({ idleTtlSec: event.target.value })}
              />
            )}
          </InfraField>
          <InfraField
            error={errors.maxContainers}
            label={t('systemGeneral.sandbox.fields.maxContainers')}
          >
            {(field) => (
              <Input
                {...field.control}
                disabled={disabled}
                inputMode="numeric"
                value={draft.maxContainers}
                onChange={(event) => onPatch({ maxContainers: event.target.value })}
              />
            )}
          </InfraField>
        </div>
      ) : (
        <span className={styles.hint}>{t('systemGeneral.sandbox.remoteHint')}</span>
      )}
    </div>
  );
});

SandboxForm.displayName = 'AdminSandboxForm';
