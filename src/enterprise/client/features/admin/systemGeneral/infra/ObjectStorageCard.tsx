'use client';

import { Button } from '@lobehub/ui/base-ui';
import { Box } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AdminSystemInfraSettings,
  AdminSystemTestDependencyResult,
} from '@/enterprise/client/services/adminSystem';

import { InfraProbeResult, InfraSettingsCard } from '../InfraSettingsCard';
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
import { useInfraEditModal } from './useInfraEditModal';
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

/** 对象存储 card: five rows that say where files go; the form and the rest live behind 编辑 / 详情. */
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

    const editModal = useInfraEditModal({
      beginEdit: editor.beginEdit,
      cancelEdit: editor.cancelEdit,
      saveCount: editor.saveCount,
    });
    const locked = editor.conflict || editor.stale;

    /** Where the bytes land, in the order an operator reads an S3 configuration. */
    const summaryFields = [
      { label: t('systemGeneral.objectStorage.fields.endpoint'), value: unset(view.endpoint) },
      { label: t('systemGeneral.objectStorage.fields.region'), value: unset(view.region) },
      { label: t('systemGeneral.objectStorage.fields.bucket'), value: unset(view.bucket) },
      { label: t('systemGeneral.objectStorage.fields.accessKeyId'), value: unset(view.accessId) },
      {
        label: t('systemGeneral.objectStorage.fields.publicDomain'),
        value: unset(view.publicDomain),
      },
    ];

    return (
      <InfraSettingsCard
        banner={failOpen ? <InfraFailOpenAlert /> : undefined}
        canTest={canOperate}
        editDirty={editor.dirty}
        editOpen={editModal.open}
        envVars={OBJECT_STORAGE_ENV}
        fields={summaryFields}
        headerExtra={<InfraSourceTag source={view.source} />}
        icon={Box}
        probe={probe}
        probing={probing}
        status={view.status}
        title={t('systemGeneral.objectStorage.title')}
        detailsFields={[
          ...summaryFields,
          {
            label: t('systemGeneral.objectStorage.fields.pathStyle'),
            value: yesNo(view.pathStyle),
          },
        ]}
        editActions={
          canOperate ? (
            <>
              <Button
                disabled={editor.blocked || locked}
                loading={editor.probing}
                size="small"
                onClick={() => void editor.test()}
              >
                {t('systemGeneral.testConnection')}
              </Button>
              <InfraEditorActions
                canCancel
                canRevert={view.source === 'db' || failOpen}
                dirty={editor.dirty}
                invalid={editor.blocked}
                locked={locked}
                saving={editor.saving}
                source={view.source}
                onCancel={() => editModal.onOpenChange(false)}
                onRevert={editor.revertToEnv}
                onSave={() => void editor.save()}
              />
            </>
          ) : undefined
        }
        editor={
          canOperate ? (
            <div className={formStyles.stack}>
              <InfraEditorAlerts
                conflict={editor.conflict}
                stale={editor.stale}
                onReload={() => void editor.reload()}
              />
              {failOpen ? <InfraFailOpenAlert /> : null}
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
              <InfraProbeResult probe={editor.probe} />
            </div>
          ) : undefined
        }
        onEditOpenChange={editModal.onOpenChange}
        onTest={onTest}
      />
    );
  },
);

ObjectStorageCard.displayName = 'AdminObjectStorageCard';
