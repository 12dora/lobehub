'use client';

import { Alert, Empty, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';

import AsyncBoundary from '@/components/AsyncBoundary';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import SkeletonList from '@/features/NavPanel/components/SkeletonList';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import RevisionBanner from '../primitives/RevisionBanner';
import StatusBadge from '../primitives/StatusBadge';
import { deriveSkillPermissions } from './controller';
import {
  useFetchAdminSkill,
  useFetchAdminSkillDependents,
  useFetchAdminSkillVersion,
  useFetchAdminSkillVersions,
} from './hooks/useAdminSkills';
import { useSkillEditor } from './hooks/useSkillEditor';
import type {
  AdminSkillGetOutput,
  AdminSkillGetVersionOutput,
  AdminSkillVersionSummary,
} from './types';

const PAGE_LIMIT = 20;

const styles = createStaticStyles(({ css }) => ({
  code: css`
    overflow: auto;

    max-height: 420px;
    margin: 0;
    padding: 12px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadius};

    font-family: ${cssVar.fontFamilyCode};
    font-size: 12px;
    color: ${cssVar.colorText};
    overflow-wrap: anywhere;
    white-space: pre-wrap;

    background: ${cssVar.colorFillQuaternary};
  `,
  dependent: css`
    display: grid;
    grid-template-columns: minmax(160px, 1fr) 100px minmax(100px, 160px);
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 720px) {
      grid-template-columns: 1fr;
    }
  `,
  identityGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
  `,
  issue: css`
    display: grid;
    grid-template-columns: 90px minmax(120px, 220px) 1fr;
    gap: 8px;

    padding-block: 8px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 720px) {
      grid-template-columns: 1fr;
    }
  `,
  pager: css`
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    padding-block-start: 12px;
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  version: css`
    display: grid;
    grid-template-columns: minmax(110px, 160px) minmax(180px, 1fr) auto auto;
    gap: 12px;
    align-items: center;

    padding-block: 10px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    @media (width <= 800px) {
      grid-template-columns: 1fr;
    }
  `,
}));

const Field = memo<{ label: string; value: React.ReactNode }>(({ label, value }) => (
  <Flexbox gap={3}>
    <Text type="secondary">{label}</Text>
    <Text>{value}</Text>
  </Flexbox>
));

Field.displayName = 'AdminSkillField';

interface VersionsSectionProps {
  canRead: boolean;
  onSelect: (versionId: string) => void;
  selectedVersionId?: string;
  skillId: string;
}

const VersionsSection = memo<VersionsSectionProps>(
  ({ canRead, selectedVersionId, skillId, onSelect }) => {
    const { t } = useTranslation('admin');
    const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
    const cursor = cursorStack.at(-1) ?? null;
    const versions = useFetchAdminSkillVersions(
      { cursor: cursor ?? undefined, limit: PAGE_LIMIT, skillId },
      canRead,
    );

    return (
      <section className={styles.section}>
        <Flexbox gap={3}>
          <Text strong as="h2">
            {t('skillCatalog.detail.versions.title')}
          </Text>
          <Text type="secondary">{t('skillCatalog.detail.versions.desc')}</Text>
        </Flexbox>
        {versions.error && !versions.data ? (
          <Alert
            showIcon
            message={t('skillCatalog.detail.versions.error')}
            type="error"
            extra={
              <Button onClick={() => void versions.mutate()}>
                {t('skillCatalog.actions.retry')}
              </Button>
            }
          />
        ) : versions.isLoading && !versions.data ? (
          <div aria-label={t('skillCatalog.detail.versions.loading')} role="status">
            <SkeletonList rows={3} />
          </div>
        ) : versions.data?.items.length ? (
          <>
            {versions.data.items.map((version) => (
              <VersionRow
                key={version.id}
                selected={version.id === selectedVersionId}
                version={version}
                onSelect={onSelect}
              />
            ))}
            <div aria-label={t('skillCatalog.pagination.label')} className={styles.pager}>
              <Button
                disabled={cursorStack.length === 0}
                onClick={() => setCursorStack((current) => current.slice(0, -1))}
              >
                {t('skillCatalog.pagination.previous')}
              </Button>
              <Button
                disabled={!versions.data.nextCursor || Boolean(versions.error)}
                onClick={() => {
                  const next = versions.data?.nextCursor;
                  if (next) setCursorStack((current) => [...current, next]);
                }}
              >
                {t('skillCatalog.pagination.next')}
              </Button>
            </div>
          </>
        ) : (
          <Empty description={t('skillCatalog.detail.versions.empty')} />
        )}
        {versions.error && versions.data ? (
          <Alert
            showIcon
            message={t('skillCatalog.detail.versions.pageError')}
            type="error"
            extra={
              <Button onClick={() => void versions.mutate()}>
                {t('skillCatalog.actions.retry')}
              </Button>
            }
          />
        ) : null}
      </section>
    );
  },
);

VersionsSection.displayName = 'AdminSkillVersionsSection';

const VersionRow = memo<{
  onSelect: (versionId: string) => void;
  selected: boolean;
  version: AdminSkillVersionSummary;
}>(({ onSelect, selected, version }) => {
  const { t } = useTranslation('admin');
  const errors = version.validation?.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = version.validation?.issues.filter(
    (issue) => issue.severity === 'warning',
  ).length;
  return (
    <div className={styles.version}>
      <Flexbox gap={2}>
        <Text strong>{version.version}</Text>
        <Text code ellipsis type="secondary">
          {version.checksum.slice(0, 12)}…
        </Text>
      </Flexbox>
      <Flexbox gap={2}>
        <Text type="secondary">{formatAdminDateTime(version.createdAt)}</Text>
        <Text type="secondary">
          {version.lastPublishedRevision
            ? t('skillCatalog.detail.versions.publishedAtRevision', {
                revision: version.lastPublishedRevision,
              })
            : t('skillCatalog.detail.versions.neverPublished')}
        </Text>
      </Flexbox>
      <Tag color={errors ? 'error' : warnings ? 'warning' : 'success'}>
        {version.validation
          ? t('skillCatalog.detail.versions.validationSummary', { errors, warnings })
          : t('skillCatalog.detail.versions.notValidated')}
      </Tag>
      <Button type={selected ? 'primary' : 'default'} onClick={() => onSelect(version.id)}>
        {selected
          ? t('skillCatalog.detail.versions.selected')
          : t('skillCatalog.detail.versions.view')}
      </Button>
    </div>
  );
});

VersionRow.displayName = 'AdminSkillVersionRow';

const VersionDetail = memo<{
  data?: AdminSkillGetVersionOutput;
  error?: unknown;
  isLoading: boolean;
  onRetry: () => void;
  selectedVersionId?: string;
}>(({ data, error, isLoading, onRetry, selectedVersionId }) => {
  const { t } = useTranslation('admin');
  if (!selectedVersionId) {
    return (
      <section className={styles.section}>
        <Text strong as="h2">
          {t('skillCatalog.detail.version.title')}
        </Text>
        <Empty description={t('skillCatalog.detail.version.select')} />
      </section>
    );
  }

  return (
    <section className={styles.section}>
      <Text strong as="h2">
        {t('skillCatalog.detail.version.title')}
      </Text>
      <AsyncBoundary data={data} error={error} isLoading={isLoading} onRetry={onRetry}>
        {data ? (
          <>
            <div className={styles.identityGrid}>
              <Field label={t('skillCatalog.detail.version.version')} value={data.version} />
              <Field
                label={t('skillCatalog.detail.version.createdAt')}
                value={formatAdminDateTime(data.createdAt)}
              />
              <Field label={t('skillCatalog.detail.version.checksum')} value={data.checksum} />
              <Field
                label={t('skillCatalog.detail.version.validator')}
                value={data.validation?.validatorVersion ?? '—'}
              />
            </div>
            <Flexbox gap={6}>
              <Text strong>{t('skillCatalog.detail.version.content')}</Text>
              <pre className={styles.code}>{data.content}</pre>
            </Flexbox>
            <Flexbox gap={6}>
              <Text strong>{t('skillCatalog.detail.version.manifest')}</Text>
              <pre className={styles.code}>{JSON.stringify(data.manifest, null, 2)}</pre>
            </Flexbox>
            <Flexbox gap={6}>
              <Text strong>{t('skillCatalog.detail.version.resources')}</Text>
              <pre className={styles.code}>{JSON.stringify(data.resources, null, 2)}</pre>
            </Flexbox>
            <Flexbox gap={6}>
              <Text strong>{t('skillCatalog.detail.version.validation')}</Text>
              {data.validation ? (
                data.validation.issues.length ? (
                  data.validation.issues.map((issue, index) => (
                    <div className={styles.issue} key={`${issue.code}-${index}`}>
                      <Tag color={issue.severity === 'error' ? 'error' : 'warning'}>
                        {t(`skillCatalog.validation.${issue.severity}` as never)}
                      </Tag>
                      <Text code>{issue.code}</Text>
                      <Flexbox gap={2}>
                        <Text>{issue.message}</Text>
                        <Text code type="secondary">
                          {issue.path.length ? issue.path.join('.') : '—'}
                        </Text>
                      </Flexbox>
                    </div>
                  ))
                ) : (
                  <Tag color="success">{t('skillCatalog.detail.version.validationPassed')}</Tag>
                )
              ) : (
                <Text type="secondary">{t('skillCatalog.detail.versions.notValidated')}</Text>
              )}
            </Flexbox>
          </>
        ) : null}
      </AsyncBoundary>
    </section>
  );
});

VersionDetail.displayName = 'AdminSkillVersionDetail';

const DependentsSection = memo<{
  canRead: boolean;
  skillId: string;
  versionId?: string;
}>(({ canRead, skillId, versionId }) => {
  const { t } = useTranslation('admin');
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const cursor = cursorStack.at(-1) ?? null;
  const input = useMemo(
    () => ({ cursor: cursor ?? undefined, limit: PAGE_LIMIT, skillId, versionId }),
    [cursor, skillId, versionId],
  );
  const dependents = useFetchAdminSkillDependents(input, canRead);

  return (
    <section className={styles.section}>
      <Flexbox gap={3}>
        <Text strong as="h2">
          {t('skillCatalog.detail.dependents.title')}
        </Text>
        <Text type="secondary">
          {versionId
            ? t('skillCatalog.detail.dependents.versionDesc')
            : t('skillCatalog.detail.dependents.skillDesc')}
        </Text>
      </Flexbox>
      {dependents.error && !dependents.data ? (
        <Alert
          showIcon
          message={t('skillCatalog.detail.dependents.error')}
          type="error"
          extra={
            <Button onClick={() => void dependents.mutate()}>
              {t('skillCatalog.actions.retry')}
            </Button>
          }
        />
      ) : dependents.isLoading && !dependents.data ? (
        <div aria-label={t('skillCatalog.detail.dependents.loading')} role="status">
          <SkeletonList rows={3} />
        </div>
      ) : dependents.data?.items.length ? (
        <>
          {dependents.data.items.map((item) => (
            <div className={styles.dependent} key={`${item.type}-${item.id}`}>
              <Flexbox gap={2}>
                <Text strong>{item.name}</Text>
                <Text code type="secondary">
                  {item.key}
                </Text>
              </Flexbox>
              <Tag>{t(`skillCatalog.dependentType.${item.type}` as never)}</Tag>
              <Text>{item.version}</Text>
            </div>
          ))}
          <div aria-label={t('skillCatalog.pagination.label')} className={styles.pager}>
            <Button
              disabled={cursorStack.length === 0}
              onClick={() => setCursorStack((current) => current.slice(0, -1))}
            >
              {t('skillCatalog.pagination.previous')}
            </Button>
            <Button
              disabled={!dependents.data.nextCursor || Boolean(dependents.error)}
              onClick={() => {
                const next = dependents.data?.nextCursor;
                if (next) setCursorStack((current) => [...current, next]);
              }}
            >
              {t('skillCatalog.pagination.next')}
            </Button>
          </div>
        </>
      ) : (
        <Empty description={t('skillCatalog.detail.dependents.empty')} />
      )}
      {dependents.error && dependents.data ? (
        <Alert
          showIcon
          message={t('skillCatalog.detail.dependents.pageError')}
          type="error"
          extra={
            <Button onClick={() => void dependents.mutate()}>
              {t('skillCatalog.actions.retry')}
            </Button>
          }
        />
      ) : null}
    </section>
  );
});

DependentsSection.displayName = 'AdminSkillDependentsSection';

const DetailContent = memo<{
  canRead: boolean;
  canUpdate: boolean;
  data: AdminSkillGetOutput;
  mutate: () => Promise<AdminSkillGetOutput | undefined>;
}>(({ canRead, canUpdate, data, mutate }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The lifecycle guard is mounted before edit fields arrive in batch C so
  // recovered drafts already protect detail-to-detail/list navigation.
  // Version selection only changes search params and remains non-destructive.
  useSkillEditor(data, canUpdate);
  const selectedVersionId =
    searchParams.get('version')?.trim() ||
    data.publishedVersion?.id ||
    data.latestVersion?.id ||
    undefined;
  const selectedVersion = useFetchAdminSkillVersion(data.draft.id, selectedVersionId, canRead);

  const selectVersion = (versionId: string) => {
    const next = new URLSearchParams(searchParams);
    next.set('version', versionId);
    setSearchParams(next, { replace: true });
  };

  return (
    <AdminPageTemplate
      description={data.draft.description || t('skillCatalog.detail.noDescription')}
      title={data.draft.displayName}
      actions={
        <Button onClick={() => navigate('/admin/skills')}>{t('skillCatalog.detail.back')}</Button>
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
      <section className={styles.section}>
        <Text strong as="h2">
          {t('skillCatalog.detail.identity.title')}
        </Text>
        <div className={styles.identityGrid}>
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
      <VersionsSection
        canRead={canRead}
        key={data.draft.id}
        selectedVersionId={selectedVersionId}
        skillId={data.draft.id}
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
