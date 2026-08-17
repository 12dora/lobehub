'use client';

import { Button } from '@lobehub/ui/base-ui';
import { Box } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';

import { InfraSettingsCard } from '../InfraSettingsCard';
import {
  fingerprintObjectStorageDraft,
  settleObjectStorageDraft,
  toObjectStorageConfig,
  toObjectStorageDisableConfig,
  toObjectStorageDraft,
  validateObjectStorageDraft,
} from './draft';
import {
  InfraEditorActions,
  InfraEditorAlerts,
  InfraFailOpenAlert,
  InfraSourceTag,
  isInfraFailOpen,
} from './editorChrome';
import { useInfraValueFormatters } from './format';
import { ObjectStorageForm } from './ObjectStorageForm';
import type { InfraSettingsMutationService } from './service';
import { infraFormStyles as formStyles } from './styles';
import { useInfraSettingsEditor } from './useInfraSettingsEditor';

/** Environment variables that drive S3 when the platform is not configured from the admin panel. */
const OBJECT_STORAGE_ENV = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_REGION',
  'S3_PUBLIC_DOMAIN',
  'S3_ENABLE_PATH_STYLE',
] as const;

export interface ObjectStorageCardProps {
  canOperate: boolean;
  onTest: () => void;
  probe?: AdminSystemTestDependencyResult;
  probing: boolean;
  service?: InfraSettingsMutationService;
  view: AdminSystemInfraSettings['objectStorage'];
}

/** 对象存储 card: read-only while the environment owns it, editable once it is managed here. */
export const ObjectStorageCard = memo<ObjectStorageCardProps>(
  ({ canOperate, onTest, probe, probing, service, view }) => {
    const { t } = useTranslation('admin');
    const { unset, yesNo } = useInfraValueFormatters();

    const seed = useMemo(() => toObjectStorageDraft(view), [view]);
    const failOpen = isInfraFailOpen(view);

    const editor = useInfraSettingsEditor({
      canOperate,
      dependency: 'objectStorage',
      fingerprint: fingerprintObjectStorageDraft,
      revision: view.revision,
      seed,
      revealErrors: failOpen,
      service,
      settle: settleObjectStorageDraft,
      source: view.source,
      toConfig: toObjectStorageConfig,
      toDisableConfig: toObjectStorageDisableConfig,
      validate: validateObjectStorageDraft,
    });

    const locked = editor.conflict || editor.stale;

    return (
      <InfraSettingsCard
        banner={failOpen ? <InfraFailOpenAlert /> : undefined}
        canTest={canOperate}
        envVars={editor.editing ? undefined : OBJECT_STORAGE_ENV}
        headerExtra={<InfraSourceTag source={view.source} />}
        icon={Box}
        probe={editor.editing ? editor.probe : probe}
        probing={editor.editing ? editor.probing : probing}
        status={view.status}
        testDisabled={editor.editing && editor.blocked}
        title={t('systemGeneral.objectStorage.title')}
        editor={
          editor.editing ? (
            <div className={formStyles.stack}>
              <InfraEditorAlerts
                conflict={editor.conflict}
                stale={editor.stale}
                onReload={() => void editor.reload()}
              />
              {view.source !== 'db' && !failOpen ? (
                <span className={formStyles.hint}>{t('systemGeneral.edit.seededFromEnv')}</span>
              ) : null}
              <ObjectStorageForm
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
              canRevert={view.source === 'db' || failOpen}
              dirty={editor.dirty}
              invalid={editor.blocked}
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
            label: t('systemGeneral.objectStorage.fields.endpoint'),
            value: unset(view.endpoint),
          },
          { label: t('systemGeneral.objectStorage.fields.region'), value: unset(view.region) },
          { label: t('systemGeneral.objectStorage.fields.bucket'), value: unset(view.bucket) },
          {
            label: t('systemGeneral.objectStorage.fields.accessKeyId'),
            value: unset(view.accessId),
          },
          {
            label: t('systemGeneral.objectStorage.fields.publicDomain'),
            value: unset(view.publicDomain),
          },
          {
            label: t('systemGeneral.objectStorage.fields.pathStyle'),
            value: yesNo(view.pathStyle),
          },
        ]}
        onTest={editor.editing ? () => void editor.test() : onTest}
      />
    );
  },
);

ObjectStorageCard.displayName = 'AdminObjectStorageCard';
