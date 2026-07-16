'use client';

import { Alert, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import RevisionBanner from '../../primitives/RevisionBanner';
import { deriveAiCatalogPermissions } from '../controller';
import { useFetchAdminAiProvider } from '../hooks/useAdminAiCatalog';
import { useAiProviderEditor } from '../hooks/useAiProviderEditor';
import ProviderModelsSection from '../models/ProviderModelsSection';
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

const ProviderDetailPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { permissions } = useAdminAccess();
  const permission = deriveAiCatalogPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminAiProvider(
    id,
    Boolean(id && permission.canUpdateProvider),
  );
  const editor = useAiProviderEditor(data);

  const content =
    data && editor.draft ? (
      <AdminPageTemplate
        description={t('aiCatalog.editor.desc')}
        title={data.draft.displayName}
        actions={
          <Button
            onClick={() =>
              navigate(`/admin/ai/models?provider=${encodeURIComponent(data.draft.providerKey)}`)
            }
          >
            {t('aiCatalog.providers.actions.viewModels')}
          </Button>
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
                    <Button onClick={() => void mutate()}>
                      {t('aiCatalog.editor.conflict.refresh')}
                    </Button>
                    <Button onClick={editor.discardLocal}>
                      {t('aiCatalog.editor.conflict.discard')}
                    </Button>
                  </Flexbox>
                }
              />
            ) : null}
          </>
        }
      >
        <ProviderEditorFields
          disabled={!permission.canUpdateProvider || editor.conflict}
          draft={editor.draft}
          providerKey={data.draft.providerKey}
          updateDraft={editor.updateDraft}
        />

        <ProviderModelsSection models={data.draft.models} permissions={permission} />

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
        </div>
      </AdminPageTemplate>
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
