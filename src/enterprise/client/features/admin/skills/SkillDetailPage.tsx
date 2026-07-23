'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import StatusBadge from '../primitives/StatusBadge';
import { deriveSkillPermissions, isSkillIdentityDirty } from './controller';
import { DependentsSection } from './DependentsSection';
import { useFetchAdminSkill, useFetchAdminSkillVersion } from './hooks/useAdminSkills';
import { useSkillActions } from './hooks/useSkillActions';
import { useSkillEditor } from './hooks/useSkillEditor';
import SkillDetailActions from './SkillDetailActions';
import SkillEditorBanners from './SkillEditorBanners';
import SkillIdentityEditor from './SkillIdentityEditor';
import type { AdminSkillGetOutput } from './types';
import { skillDetailSectionStyles } from './useCursorPagedList';
import { VersionDetail, VersionsSection } from './VersionsSection';

const Field = memo<{ label: string; value: ReactNode }>(({ label, value }) => (
  <Flexbox gap={3}>
    <Text type="secondary">{label}</Text>
    <Text>{value}</Text>
  </Flexbox>
));

Field.displayName = 'AdminSkillField';

const DetailContent = memo<{
  canRead: boolean;
  canUpdate: boolean;
  data: AdminSkillGetOutput;
  mutate: () => Promise<AdminSkillGetOutput | undefined>;
}>(({ canRead, canUpdate, data, mutate }) => {
  const { t } = useTranslation('admin');
  const { authMethod, permissions } = useAdminAccess();
  const permission = deriveSkillPermissions(permissions);
  const [searchParams, setSearchParams] = useSearchParams();
  // The lifecycle guard is mounted before edit fields arrive in batch C so
  // recovered drafts already protect detail-to-detail/list navigation.
  // Version selection only changes search params and remains non-destructive.
  const editor = useSkillEditor(data, canUpdate);
  const selectedVersionId =
    searchParams.get('version')?.trim() ||
    data.publishedVersion?.id ||
    data.latestVersion?.id ||
    undefined;
  const selectedVersion = useFetchAdminSkillVersion(data.draft.id, selectedVersionId, canRead);
  const actions = useSkillActions({
    authMethod: authMethod ?? null,
    data,
    editor,
    permissions: permission,
    selectedValidation: selectedVersion.data?.validation ?? null,
    selectedVersionId,
  });
  const identityDirty = isSkillIdentityDirty(editor.draft, editor.baseDraft);

  const selectVersion = (versionId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('version', versionId);
    setSearchParams(next, { replace: true });
  };

  const actionsDisabled =
    Boolean(actions.actionLoading) || editor.conflict || actions.refreshFailed;

  return (
    <AdminPageTemplate
      description={data.draft.description || t('skillCatalog.detail.noDescription')}
      title={data.draft.displayName}
      actions={
        <SkillDetailActions
          actionsDisabled={actionsDisabled}
          archiveDisabled={actionsDisabled || editor.dirty}
          canArchive={permission.canArchive}
          canPublish={permission.canPublish}
          canPublishSelected={actions.canPublishSelected}
          canUpdate={permission.canUpdate}
          dirty={editor.dirty}
          identityDirty={identityDirty}
          isArchived={data.draft.status === 'archived'}
          saveFailed={editor.saveState === 'failed'}
          selectedVersionId={selectedVersionId}
          onArchive={actions.openArchive}
          onCreateVersion={actions.openCreateVersion}
          onPublish={actions.openPublish}
          onSaveIdentity={actions.openSaveIdentity}
          onValidate={actions.openValidate}
        />
      }
      banner={
        <RevisionBanner
          draftRevision={data.baseRevision}
          publishedRevision={data.publishedVersion?.lastPublishedRevision ?? null}
          status={data.draft.status}
          onRefresh={() => void mutate()}
        />
      }
    >
      <SkillEditorBanners
        actionError={editor.actionError}
        actionLoading={actions.actionLoading}
        conflict={editor.conflict}
        persistenceStatus={editor.persistenceStatus}
        rebaseConflicts={editor.rebaseConflicts}
        refreshFailed={actions.refreshFailed}
        onDiscardLocal={editor.discardLocal}
        onResolveRebaseConflict={editor.resolveRebaseConflict}
        onRetryRefresh={() => void actions.retryRefresh()}
        onRebase={async () => {
          const latest = await mutate();
          if (latest) editor.rebaseLocal(latest);
        }}
      />
      {permission.canUpdate && editor.draft ? (
        <SkillIdentityEditor
          disabled={Boolean(actions.actionLoading) || editor.conflict || actions.refreshFailed}
          draft={editor.draft.identity}
          onChange={editor.updateIdentity}
        />
      ) : (
        <section className={skillDetailSectionStyles.section}>
          <Text strong as="h2">
            {t('skillCatalog.detail.identity.title')}
          </Text>
          <div className={skillDetailSectionStyles.identityGrid}>
            <Field label={t('skillCatalog.detail.identity.key')} value={data.draft.skillKey} />
            <Field
              label={t('skillCatalog.detail.identity.status')}
              value={<StatusBadge status={data.draft.status} />}
            />
            <Field
              label={t('skillCatalog.detail.identity.source')}
              value={t(`skillCatalog.source.${data.draft.source}` as never)}
            />
            <Field
              label={t('skillCatalog.detail.identity.distribution')}
              value={t(`skillCatalog.distribution.${data.draft.distribution}` as never)}
            />
            <Field
              label={t('skillCatalog.detail.identity.enabled')}
              value={t(`skillCatalog.boolean.${data.draft.enabled}` as never)}
            />
            <Field label={t('skillCatalog.detail.identity.revision')} value={data.draft.revision} />
          </div>
        </section>
      )}
      <VersionsSection
        actionLoading={Boolean(actions.actionLoading) || actions.refreshFailed}
        canRead={canRead}
        canRollback={permission.canPublish && !editor.dirty && !editor.conflict}
        key={data.draft.id}
        selectedVersionId={selectedVersionId}
        skillId={data.draft.id}
        onRollback={actions.openRollback}
        onSelect={selectVersion}
      />
      <VersionDetail
        data={selectedVersion.data}
        error={selectedVersion.error}
        isLoading={selectedVersion.isLoading}
        selectedVersionId={selectedVersionId}
        onRetry={() => void selectedVersion.mutate()}
      />
      <DependentsSection
        canRead={canRead}
        key={`${data.draft.id}:${selectedVersionId ?? 'all'}`}
        skillId={data.draft.id}
        versionId={selectedVersionId}
      />
    </AdminPageTemplate>
  );
});

DetailContent.displayName = 'AdminSkillDetailContent';

const SkillDetailPage = memo(() => {
  const { id } = useParams<{ id: string }>();
  const { permissions } = useAdminAccess();
  const { canRead, canUpdate } = deriveSkillPermissions(permissions);
  const detail = useFetchAdminSkill(id, canRead);

  return (
    <AsyncBoundary
      data={detail.data}
      error={detail.error}
      isLoading={detail.isLoading}
      onRetry={() => void detail.mutate()}
    >
      {detail.data ? (
        <DetailContent
          canRead={canRead}
          canUpdate={canUpdate}
          data={detail.data}
          mutate={detail.mutate}
        />
      ) : null}
    </AsyncBoundary>
  );
});

SkillDetailPage.displayName = 'AdminSkillDetailPage';

export default SkillDetailPage;
