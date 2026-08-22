'use client';

import { Text } from '@lobehub/ui';
import { FileImage } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type {
  AdminDocumentRenderSettingsService,
  AdminSystemDocumentRenderSettings,
  AdminSystemDocumentRenderStatus,
} from '@/enterprise/client/services/adminSystem';
import { adminSystemService } from '@/enterprise/client/services/adminSystem';

import { useAdminDocumentRenderStatus } from '../hooks';
import { InfraSettingsCard } from '../InfraSettingsCard';
import { bytesToMib } from './documentRenderDraft';
import { DocumentRenderForm } from './DocumentRenderForm';
import { DocumentRenderStatusPanel } from './DocumentRenderStatusPanel';
import { InfraEditorActions, InfraEditorAlerts, InfraSourceTag } from './editorChrome';
import { useInfraValueFormatters } from './format';
import { infraFormStyles as formStyles } from './styles';
import { useDocumentRenderSettingsEditor } from './useDocumentRenderSettingsEditor';
import { useInfraEditModal } from './useInfraEditModal';

const DOCUMENT_RENDER_ENV = [
  'DOCUMENT_RENDER_URL',
  'DOCUMENT_RENDER_TRIGGER',
  'DOCUMENT_RENDER_MAX_PAGES',
  'DOCUMENT_RENDER_MAX_FILE_BYTES',
  'DOCUMENT_RENDER_CONCURRENCY',
  'DOCUMENT_RENDER_TIMEOUT_SEC',
  'DOCUMENT_RENDER_LONG_EDGE_PX',
  'DOCUMENT_RENDER_THUMB_EDGE_PX',
] as const;

/**
 * The settings card reads the sidecar's health through the same vocabulary the other 基础设施 cards
 * use, so one glance across the grid means the same thing everywhere.
 */
const CARD_STATUS: Record<AdminSystemDocumentRenderStatus['sidecar']['status'], string> = {
  disabled: 'disabled',
  down: 'unavailable',
  unconfigured: 'disabled',
  up: 'healthy',
};

export interface DocumentRenderCardProps {
  canOperate: boolean;
  moduleEnabled: boolean;
  service?: AdminDocumentRenderSettingsService;
  view?: AdminSystemDocumentRenderSettings;
}

/** An off module still owns a full-height card, so the grid stays aligned. */
export const DocumentRenderDisabledHint = memo(() => {
  const { t } = useTranslation('admin');
  return (
    <InfraSettingsCard
      canTest={false}
      icon={FileImage}
      probing={false}
      title={t('systemGeneral.documentRender.title')}
      notice={
        <Text type="secondary">
          {t('systemGeneral.documentRender.moduleDisabled')}{' '}
          <Link to="/admin/system/modules">{t('systemGeneral.documentRender.openModules')}</Link>
        </Text>
      }
      onTest={() => undefined}
    />
  );
});

DocumentRenderDisabledHint.displayName = 'AdminDocumentRenderDisabledHint';

export const DocumentRenderCard = memo<DocumentRenderCardProps>(
  ({ canOperate, moduleEnabled, service, view }) => {
    if (!moduleEnabled) return <DocumentRenderDisabledHint />;
    if (!view) return null;

    return <DocumentRenderCardBody canOperate={canOperate} service={service} view={view} />;
  },
);

DocumentRenderCard.displayName = 'AdminDocumentRenderCard';

const DocumentRenderCardBody = memo<{
  canOperate: boolean;
  service?: AdminDocumentRenderSettingsService;
  view: AdminSystemDocumentRenderSettings;
}>(({ canOperate, service = adminSystemService, view }) => {
  const { t } = useTranslation('admin');
  const { unset, yesNo } = useInfraValueFormatters();
  const editor = useDocumentRenderSettingsEditor({ canOperate, service, view });
  const editModal = useInfraEditModal({
    beginEdit: editor.beginEdit,
    cancelEdit: editor.cancelEdit,
    saveCount: editor.saveCount,
  });
  const locked = editor.conflict || editor.stale;
  // Polled only while the card is actually on screen with a configuration to report.
  const statusQuery = useAdminDocumentRenderStatus(true, service);
  const status = statusQuery.data;

  const endpointField = {
    label: t('systemGeneral.documentRender.fields.endpoint'),
    value: unset(view.config.endpoint),
  };
  const triggerField = {
    label: t('systemGeneral.documentRender.fields.trigger'),
    value: t(`systemGeneral.documentRender.trigger.${view.config.trigger}` as never),
  };
  const mediaThresholdField = {
    label: t('systemGeneral.documentRender.fields.mediaThresholdT2'),
    value: unset(view.config.mediaThresholdT2),
  };
  const retentionField = {
    label: t('systemGeneral.documentRender.fields.retentionDays'),
    value: unset(view.config.retentionDays),
  };

  /**
   * The queue in one line. Depth is the reading an operator wants from the grid — everything else
   * the sidecar reports (latencies, recent jobs, sweeps, feed counters) is a 详情 question.
   */
  const queueField = {
    label: t('systemGeneral.documentRender.fields.queue'),
    value: status
      ? t('systemGeneral.documentRender.queue.summary', {
          pending: status.queue.pending,
          running: status.queue.running,
        })
      : undefined,
  };

  const summaryFields = [
    endpointField,
    triggerField,
    mediaThresholdField,
    retentionField,
    queueField,
  ];

  const detailsFields = [
    endpointField,
    triggerField,
    {
      label: t('systemGeneral.documentRender.fields.pptxAlwaysT2'),
      value: yesNo(view.config.pptxAlwaysT2),
    },
    mediaThresholdField,
    {
      label: t('systemGeneral.documentRender.fields.maxPages'),
      value: unset(view.config.maxPages),
    },
    {
      label: t('systemGeneral.documentRender.fields.maxFileBytesMib'),
      value: bytesToMib(view.config.maxFileBytes),
    },
    {
      label: t('systemGeneral.documentRender.fields.concurrency'),
      value: unset(view.config.concurrency),
    },
    {
      label: t('systemGeneral.documentRender.fields.timeoutSec'),
      value: unset(view.config.timeoutSec),
    },
    {
      label: t('systemGeneral.documentRender.fields.longEdgePx'),
      value: unset(view.config.longEdgePx),
    },
    {
      label: t('systemGeneral.documentRender.fields.thumbEdgePx'),
      value: unset(view.config.thumbEdgePx),
    },
    {
      label: t('systemGeneral.documentRender.fields.tilesForDensePages'),
      value: yesNo(view.config.tilesForDensePages),
    },
    {
      label: t('systemGeneral.documentRender.fields.contactSheet'),
      value: `${view.config.contactSheetCols} × ${view.config.contactSheetRows}`,
    },
    {
      label: t('systemGeneral.documentRender.fields.maxDocsPerRequest'),
      value: unset(view.config.maxDocsPerRequest),
    },
    {
      label: t('systemGeneral.documentRender.fields.maxImagesDefault'),
      value: unset(view.config.maxImagesDefault),
    },
    retentionField,
  ];

  return (
    <InfraSettingsCard
      canTest={canOperate}
      detailsFields={detailsFields}
      editDirty={editor.dirty}
      editOpen={editModal.open}
      envVars={DOCUMENT_RENDER_ENV}
      fields={summaryFields}
      headerExtra={<InfraSourceTag source={view.source} />}
      icon={FileImage}
      probe={editor.probe}
      probing={editor.probing}
      status={status ? CARD_STATUS[status.sidecar.status] : undefined}
      title={t('systemGeneral.documentRender.title')}
      details={
        status ? (
          <DocumentRenderStatusPanel
            canOperate={canOperate}
            service={service}
            status={status}
            onRefresh={() => statusQuery.mutate()}
          />
        ) : undefined
      }
      editActions={
        canOperate ? (
          <InfraEditorActions
            canCancel
            canRevert={view.source === 'db'}
            dirty={editor.dirty}
            invalid={editor.invalid}
            locked={locked}
            saving={editor.saving}
            source={view.source}
            onCancel={() => editModal.onOpenChange(false)}
            onRevert={editor.revertToEnv}
            onSave={() => void editor.save()}
          />
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
            {view.source !== 'db' ? (
              <span className={formStyles.hint}>
                {t('systemGeneral.documentRender.edit.seededFromEnv')}
              </span>
            ) : null}
            <DocumentRenderForm
              disabled={editor.saving || locked}
              draft={editor.draft}
              errors={editor.errors}
              onPatch={editor.patch}
            />
            <span className={formStyles.hint}>{t('systemGeneral.edit.applyHint')}</span>
          </div>
        ) : undefined
      }
      onEditOpenChange={editModal.onOpenChange}
      onTest={() => void editor.test()}
    />
  );
});

DocumentRenderCardBody.displayName = 'AdminDocumentRenderCardBody';
