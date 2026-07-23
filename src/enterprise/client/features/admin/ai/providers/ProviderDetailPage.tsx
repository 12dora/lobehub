'use client';

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import RevisionBanner from '../../primitives/RevisionBanner';
import type { AiCatalogPermissions, EditableAiProviderDraft } from '../controller';
import { deriveAiCatalogPermissions } from '../controller';
import { useFetchAdminAiProvider } from '../hooks/useAdminAiCatalog';
import { useAiProviderActions } from '../hooks/useAiProviderActions';
import { useAiProviderEditor } from '../hooks/useAiProviderEditor';
import ProviderModelsSection from '../models/ProviderModelsSection';
import type { AdminAiProviderGetOutput } from '../types';
import ProviderConnectionTestPanel from './ProviderConnectionTestPanel';
import ProviderEditorFields from './ProviderEditorFields';
import ProviderRevisionsPanel from './ProviderRevisionsPanel';
import ProviderSecretPanel from './ProviderSecretPanel';

const styles = createStaticStyles(({ css }) => ({
  footer: css`
    position: sticky;
    z-index: 2;
    inset-block-end: 0;

    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 16px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    background: ${cssVar.colorBgLayout};
  `,
}));

interface ProviderDetailContentProps {
  authMethod: AdminAccessContextValue['authMethod'];
  data: AdminAiProviderGetOutput;
  editor: ReturnType<typeof useAiProviderEditor>;
  mutate: () => Promise<AdminAiProviderGetOutput | undefined>;
  permission: AiCatalogPermissions;
}

const ProviderDetailContent = memo<ProviderDetailContentProps>(
  ({ authMethod, data, editor, mutate, permission }) => {
    const { t } = useTranslation('admin');
    const navigate = useNavigate();
    const [rebaseLoading, setRebaseLoading] = useState(false);
    const actions = useAiProviderActions({
      authMethod: authMethod ?? null,
      data,
      editor,
      permissions: permission,
    });
    const collectionLocked = editor.dirty || editor.conflict || actions.reloadRequired;
    const rebaseFieldLabels: Record<keyof EditableAiProviderDraft, string> = {
      checkModel: t('aiCatalog.editor.checkModel'),
      configText: t('aiCatalog.editor.config'),
      description: t('aiCatalog.editor.description'),
      displayName: t('aiCatalog.editor.displayName'),
      enabled: t('aiCatalog.editor.enabled'),
      fetchOnClient: t('aiCatalog.editor.fetchOnClient'),
      logo: t('aiCatalog.editor.logo'),
      settingsText: t('aiCatalog.editor.settings'),
      sort: t('aiCatalog.editor.sort'),
    };

    const handleRebase = async () => {
      setRebaseLoading(true);
      editor.setActionError(null);
      try {
        const latest = await mutate();
        if (latest) editor.rebaseLocal(latest);
        else editor.setActionError(t('aiCatalog.editor.conflict.refreshFailed'));
      } catch {
        editor.setActionError(t('aiCatalog.editor.conflict.refreshFailed'));
      } finally {
        setRebaseLoading(false);
      }
    };

    return (
      <AdminPageTemplate
        description={t('aiCatalog.editor.desc')}
        title={data.draft.displayName}
        actions={
          <>
            <Button
              onClick={() =>
                navigate(
                  `/admin/ai/catalog/models?provider=${encodeURIComponent(data.draft.providerKey)}`,
                )
              }
            >
              {t('aiCatalog.providers.actions.viewModels')}
            </Button>
            {permission.canArchiveProvider && data.draft.status !== 'archived' ? (
              <Button danger disabled={collectionLocked} onClick={actions.handleArchive}>
                {t('aiCatalog.actions.archive.label')}
              </Button>
            ) : null}
          </>
        }
        banner={
          <>
            <RevisionBanner
              conflict={editor.conflict}
              draftRevision={data.baseRevision}
              publishedRevision={data.published?.revision ?? null}
              status={data.draft.status}
              onRefresh={actions.reloadRequired ? undefined : () => void mutate()}
            />
            {editor.conflict ? (
              <Alert
                showIcon
                description={t('aiCatalog.editor.conflict.desc')}
                message={t('aiCatalog.editor.conflict.title')}
                type="warning"
                extra={
                  <Flexbox horizontal gap={8}>
                    <Button loading={rebaseLoading} onClick={() => void handleRebase()}>
                      {t('aiCatalog.editor.conflict.rebase')}
                    </Button>
                    <Button onClick={editor.discardLocal}>
                      {t('aiCatalog.editor.conflict.discard')}
                    </Button>
                  </Flexbox>
                }
              />
            ) : null}
            {editor.rebaseConflicts.length > 0 ? (
              <Alert
                showIcon
                message={t('aiCatalog.editor.conflict.fields')}
                type="warning"
                description={
                  <Flexbox gap={12}>
                    {editor.rebaseConflicts.map((item) => (
                      <Flexbox gap={6} key={item.field}>
                        <Text strong>{rebaseFieldLabels[item.field]}</Text>
                        <Text code type="secondary">
                          {t('aiCatalog.editor.conflict.localValue', {
                            value: String(item.local),
                          })}
                        </Text>
                        <Text code type="secondary">
                          {t('aiCatalog.editor.conflict.latestValue', {
                            value: String(item.latest),
                          })}
                        </Text>
                        <Flexbox horizontal gap={8}>
                          <Button onClick={() => editor.resolveRebaseConflict(item.field, 'local')}>
                            {t('aiCatalog.editor.conflict.keepLocal')}
                          </Button>
                          <Button
                            onClick={() => editor.resolveRebaseConflict(item.field, 'latest')}
                          >
                            {t('aiCatalog.editor.conflict.useLatest')}
                          </Button>
                        </Flexbox>
                      </Flexbox>
                    ))}
                  </Flexbox>
                }
              />
            ) : null}
          </>
        }
      >
        <ProviderEditorFields
          disabled={!permission.canUpdateProvider || editor.conflict || actions.reloadRequired}
          draft={editor.draft!}
          jsonErrors={editor.jsonErrors}
          providerKey={data.draft.providerKey}
          updateDraft={editor.updateDraft}
        />

        <ProviderModelsSection
          actionLoadingId={actions.actionLoadingId}
          models={data.draft.models}
          permissions={permission}
          onCreate={collectionLocked ? undefined : actions.handleCreateModel}
          onReorder={collectionLocked ? undefined : actions.handleReorderModels}
          onDelete={
            collectionLocked || !permission.canReadModels
              ? undefined
              : (model) => void actions.handleDeleteModel(model)
          }
          onEdit={
            collectionLocked || !permission.canReadModels
              ? undefined
              : (model) => void actions.handleEditModel(model)
          }
        />

        <ProviderSecretPanel
          canUpdate={permission.canUpdateProvider}
          disabled={collectionLocked}
          secret={data.draft.secret}
          onApply={actions.handleSecret}
        />

        <ProviderConnectionTestPanel connectionTest={editor.connectionTest} />

        <ProviderRevisionsPanel
          baseRevision={data.baseRevision}
          canPublish={permission.canPublishProvider}
          canRead={permission.canReadProviders}
          disabled={collectionLocked}
          providerId={data.draft.id}
          onRollback={(revision) => actions.handleRollback(revision)}
        />

        {actions.reloadRequired ? (
          <Alert
            showIcon
            description={t('aiCatalog.refresh.committed.desc')}
            type="warning"
            extra={
              <Button
                disabled={actions.refreshPending}
                loading={actions.refreshPending || actions.refreshRetrying}
                onClick={() => void actions.retryRefresh()}
              >
                {t('aiCatalog.refresh.retry')}
              </Button>
            }
            message={t(
              actions.refreshPending
                ? 'aiCatalog.refresh.committed.pending'
                : 'aiCatalog.refresh.committed.title',
            )}
          />
        ) : null}

        <div className={styles.footer}>
          <Flexbox gap={4}>
            <Text type="secondary">
              {t(`aiCatalog.editor.saveState.${editor.saveState}` as never)}
            </Text>
            {editor.actionError ? (
              <Text role="alert" type="danger">
                {editor.actionError}
              </Text>
            ) : null}
          </Flexbox>
          {actions.primaryAction !== 'none' ? (
            <Button type="primary" onClick={actions.handlePrimary}>
              {t(`aiCatalog.actions.${actions.primaryAction}.label` as never)}
            </Button>
          ) : null}
        </div>
      </AdminPageTemplate>
    );
  },
);

ProviderDetailContent.displayName = 'AdminAiProviderDetailContent';

const ProviderDetailPage = memo(() => {
  const { id } = useParams<{ id: string }>();
  const { authMethod, permissions } = useAdminAccess();
  const permission = deriveAiCatalogPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminAiProvider(
    id,
    Boolean(id && permission.canReadProviders),
  );
  const editor = useAiProviderEditor(data, permission.canUpdateProvider);

  const content =
    data && editor.draft ? (
      <ProviderDetailContent
        authMethod={authMethod}
        data={data}
        editor={editor}
        mutate={mutate}
        permission={permission}
      />
    ) : null;

  return (
    <AsyncBoundary
      data={data}
      error={error}
      errorVariant="page"
      isLoading={isLoading}
      loading={<Loading debugId="AdminAiProviderDetail" />}
      onRetry={() => void mutate()}
    >
      {content}
    </AsyncBoundary>
  );
});

ProviderDetailPage.displayName = 'AdminAiProviderDetailPage';

export default ProviderDetailPage;
