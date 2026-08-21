'use client';

import { Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Container } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type {
  AdminSandboxSettingsService,
  AdminSystemSandboxSettings,
} from '@/enterprise/client/services/adminSystem';

import { InfraSettingsCard } from '../InfraSettingsCard';
import { InfraEditorActions, InfraEditorAlerts, InfraSourceTag } from './editorChrome';
import { useInfraValueFormatters } from './format';
import { SandboxForm } from './SandboxForm';
import { infraFormStyles as formStyles } from './styles';
import { useSandboxSettingsEditor } from './useSandboxSettingsEditor';

const SANDBOX_ENV = [
  'SANDBOX_PROVIDER',
  'SANDBOX_DOCKER_SOCKET',
  'SANDBOX_DOCKER_HOST',
  'SANDBOX_LOCAL_IMAGE',
  'SANDBOX_LOCAL_PULL_POLICY',
  'SANDBOX_LOCAL_NETWORK',
  'SANDBOX_LOCAL_MEMORY_MB',
  'SANDBOX_LOCAL_PIDS_LIMIT',
  'SANDBOX_LOCAL_CPUS',
  'SANDBOX_LOCAL_TIMEOUT_MS',
  'SANDBOX_LOCAL_MAX_OUTPUT_BYTES',
  'SANDBOX_LOCAL_IDLE_TTL_SEC',
  'SANDBOX_LOCAL_MAX_CONTAINERS',
] as const;

export interface SandboxCardProps {
  canOperate: boolean;
  moduleEnabled: boolean;
  service?: AdminSandboxSettingsService;
  view?: AdminSystemSandboxSettings;
}

export const SandboxDisabledHint = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <InfraSettingsCard
      canTest={false}
      icon={Container}
      probing={false}
      title={t('systemGeneral.sandbox.title')}
      notice={
        <Text type="secondary">
          {t('systemGeneral.sandbox.moduleDisabled')}{' '}
          <Link to="/admin/system/modules">{t('systemGeneral.sandbox.openModules')}</Link>
        </Text>
      }
      onTest={() => undefined}
    />
  );
});

SandboxDisabledHint.displayName = 'AdminSandboxDisabledHint';

export const SandboxCard = memo<SandboxCardProps>(
  ({ canOperate, moduleEnabled, service, view }) => {
    if (!moduleEnabled) return <SandboxDisabledHint />;
    if (!view) return null;

    return <SandboxCardBody canOperate={canOperate} service={service} view={view} />;
  },
);

SandboxCard.displayName = 'AdminSandboxCard';

const SandboxCardBody = memo<{
  canOperate: boolean;
  service?: AdminSandboxSettingsService;
  view: AdminSystemSandboxSettings;
}>(({ canOperate, service, view }) => {
  const { t } = useTranslation('admin');
  const { unset } = useInfraValueFormatters();
  const editor = useSandboxSettingsEditor({ canOperate, service, view });
  const locked = editor.conflict || editor.stale;

  const localFields =
    view.provider === 'local'
      ? [
          {
            label: t('systemGeneral.sandbox.fields.dockerSocket'),
            value: unset(view.dockerSocket),
          },
          { label: t('systemGeneral.sandbox.fields.dockerHost'), value: unset(view.dockerHost) },
          { label: t('systemGeneral.sandbox.fields.image'), value: unset(view.image) },
          {
            label: t('systemGeneral.sandbox.fields.pullPolicy'),
            value: t(`systemGeneral.sandbox.pullPolicy.${view.pullPolicy}` as never),
          },
          {
            label: t('systemGeneral.sandbox.fields.network'),
            value: t(`systemGeneral.sandbox.network.${view.network}` as never),
          },
          { label: t('systemGeneral.sandbox.fields.memoryMb'), value: unset(view.memoryMb) },
          { label: t('systemGeneral.sandbox.fields.pidsLimit'), value: unset(view.pidsLimit) },
          { label: t('systemGeneral.sandbox.fields.cpus'), value: unset(view.cpus) },
          { label: t('systemGeneral.sandbox.fields.timeoutMs'), value: unset(view.timeoutMs) },
          {
            label: t('systemGeneral.sandbox.fields.maxOutputBytes'),
            value: unset(view.maxOutputBytes),
          },
          { label: t('systemGeneral.sandbox.fields.idleTtlSec'), value: unset(view.idleTtlSec) },
          {
            label: t('systemGeneral.sandbox.fields.maxContainers'),
            value: unset(view.maxContainers),
          },
        ]
      : [];

  return (
    <InfraSettingsCard
      canTest={false}
      envVars={editor.editing ? undefined : SANDBOX_ENV}
      headerExtra={<InfraSourceTag source={view.source} />}
      icon={Container}
      probing={false}
      title={t('systemGeneral.sandbox.title')}
      editor={
        editor.editing ? (
          <div className={formStyles.stack}>
            <InfraEditorAlerts
              conflict={editor.conflict}
              stale={editor.stale}
              onReload={() => void editor.reload()}
            />
            {view.source !== 'db' ? (
              <span className={formStyles.hint}>
                {t('systemGeneral.sandbox.edit.seededFromEnv')}
              </span>
            ) : null}
            <SandboxForm
              disabled={editor.saving || locked}
              draft={editor.draft}
              errors={editor.errors}
              onPatch={editor.patch}
            />
            <span className={formStyles.hint}>{t('systemGeneral.edit.applyHint')}</span>
          </div>
        ) : undefined
      }
      extraActions={
        editor.editing ? (
          <InfraEditorActions
            canCancel={view.source !== 'db'}
            canRevert={view.source === 'db'}
            dirty={editor.dirty}
            invalid={editor.invalid}
            locked={locked}
            saving={editor.saving}
            source={view.source}
            onCancel={editor.cancelEdit}
            onRevert={editor.revertToEnv}
            onSave={() => void editor.save()}
          />
        ) : canOperate ? (
          <Button size="small" onClick={editor.beginEdit}>
            {t('systemGeneral.edit.switchToDb')}
          </Button>
        ) : null
      }
      fields={[
        {
          label: t('systemGeneral.sandbox.fields.provider'),
          value: t(`systemGeneral.sandbox.provider.${view.provider}` as never),
        },
        ...localFields,
      ]}
      onTest={() => undefined}
    />
  );
});

SandboxCardBody.displayName = 'AdminSandboxCardBody';
