'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import RevisionBanner from '../../primitives/RevisionBanner';
import StatusBadge from '../../primitives/StatusBadge';
import type { AiCatalogPermissions, EditableAiProviderDraft } from '../controller';
import { deriveAiCatalogPermissions } from '../controller';
import {
  useFetchAdminAiProvider,
  useFetchAdminAiProviderRevisions,
} from '../hooks/useAdminAiCatalog';
import { useAiProviderActions } from '../hooks/useAiProviderActions';
import { useAiProviderEditor } from '../hooks/useAiProviderEditor';
import ProviderModelsSection from '../models/ProviderModelsSection';
import type { AdminAiProviderGetOutput } from '../types';
import ProviderEditorFields from './ProviderEditorFields';

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
  revision: css`
    display: grid;
    grid-template-columns: 100px 120px minmax(180px, 1fr) auto;
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 800px) {
      grid-template-columns: 1fr;
    }
  `,
  revisions: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  secret: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  testResult: css`
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};
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
    const [revisionCursorStack, setRevisionCursorStack] = useState<number[]>([]);
    const revisionCursor = revisionCursorStack.at(-1);
    const revisions = useFetchAdminAiProviderRevisions(
      data.draft.id,
      permission.canReadProviders,
      revisionCursor,
    );
    const actions = useAiProviderActions({
      authMethod: authMethod ?? null,
      data,
      editor,
      permissions: permission,
    });
    const collectionLocked = editor.dirty || editor.conflict;
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
                navigate(`/admin/ai/models?provider=${encodeURIComponent(data.draft.providerKey)}`)
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
              onRefresh={() => void mutate()}
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
          disabled={!permission.canUpdateProvider || editor.conflict}
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

        <section className={styles.secret}>
          <Flexbox gap={4}>
            <Flexbox horizontal align="center" gap={8}>
              <Text strong>{t('aiCatalog.editor.secret.title')}</Text>
              <Tag color={data.draft.secret.configured ? 'success' : 'warning'}>
                {t(
                  data.draft.secret.configured
                    ? 'aiCatalog.providers.secret.configured'
                    : 'aiCatalog.providers.secret.missing',
                )}
              </Tag>
            </Flexbox>
            <Text type="secondary">{t('aiCatalog.editor.secret.neverReveal')}</Text>
            {data.draft.secret.fingerprint ? (
              <Text code type="secondary">
                {data.draft.secret.fingerprint}
              </Text>
            ) : null}
          </Flexbox>
          {permission.canUpdateProvider ? (
            <Button disabled={collectionLocked} onClick={actions.handleSecret}>
              {t('aiCatalog.secret.apply')}
            </Button>
          ) : null}
        </section>

        {editor.testResult ? (
          <section aria-live="polite" className={styles.testResult}>
            <Flexbox gap={4}>
              <Text strong>{t(`aiCatalog.editor.test.${editor.testResult.status}` as never)}</Text>
              <Text type="secondary">
                {t('aiCatalog.editor.test.summary', {
                  latency: editor.testResult.latencyMs,
                  message: editor.testResult.sanitizedMessage,
                })}
              </Text>
            </Flexbox>
          </section>
        ) : null}

        <section className={styles.revisions}>
          <Flexbox gap={4}>
            <Text strong>{t('aiCatalog.revisions.title')}</Text>
            <Text type="secondary">{t('aiCatalog.revisions.desc')}</Text>
          </Flexbox>
          {revisions.error ? (
            <Alert
              showIcon
              message={t('aiCatalog.revisions.error')}
              type="error"
              extra={
                <Button onClick={() => void revisions.mutate()}>
                  {t('aiCatalog.revisions.retry')}
                </Button>
              }
            />
          ) : revisions.isLoading && !revisions.data ? (
            <Text type="secondary">{t('aiCatalog.revisions.loading')}</Text>
          ) : revisions.data?.items.length ? (
            <>
              {revisions.data.items.map((revision) => (
                <div className={styles.revision} key={revision.revision}>
                  <Text>#{revision.revision}</Text>
                  <StatusBadge status={revision.status} />
                  <Flexbox gap={2}>
                    <Text>{revision.comment || t('aiCatalog.revisions.noComment')}</Text>
                    <Text type="secondary">{formatAdminDateTime(revision.publishedAt)}</Text>
                  </Flexbox>
                  {permission.canPublishProvider &&
                  revision.status === 'published' &&
                  revision.revision !== data.baseRevision ? (
                    <Button
                      danger
                      disabled={collectionLocked}
                      onClick={() => actions.handleRollback(revision.revision)}
                    >
                      {t('aiCatalog.actions.rollback.label')}
                    </Button>
                  ) : null}
                </div>
              ))}
              <Flexbox horizontal gap={8} justify="flex-end">
                <Button
                  disabled={revisionCursorStack.length === 0}
                  onClick={() => setRevisionCursorStack((current) => current.slice(0, -1))}
                >
                  {t('aiCatalog.revisions.previous')}
                </Button>
                <Button
                  disabled={!revisions.data.nextCursor}
                  onClick={() => {
                    const nextCursor = revisions.data?.nextCursor;
                    if (!nextCursor) return;
                    setRevisionCursorStack((current) => [...current, nextCursor]);
                  }}
                >
                  {t('aiCatalog.revisions.next')}
                </Button>
              </Flexbox>
            </>
          ) : (
            <Text type="secondary">{t('aiCatalog.revisions.empty')}</Text>
          )}
        </section>

        {actions.refreshFailed ? (
          <Alert
            showIcon
            description={t('aiCatalog.refresh.committed.desc')}
            message={t('aiCatalog.refresh.committed.title')}
            type="warning"
            extra={
              <Button loading={actions.refreshRetrying} onClick={() => void actions.retryRefresh()}>
                {t('aiCatalog.refresh.retry')}
              </Button>
            }
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
    Boolean(id && permission.canUpdateProvider),
  );
  const editor = useAiProviderEditor(data);

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
