'use client';

import { Empty, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import AsyncBoundary from '@/components/AsyncBoundary';
import { formatAdminDateTime } from '@/enterprise/client/features/admin/users/utils';

import { useFetchAdminSkillVersions } from './hooks/useAdminSkills';
import type { AdminSkillGetVersionOutput, AdminSkillVersionSummary } from './types';
import {
  CursorPagedListSurface,
  skillDetailSectionStyles,
  useCursorStack,
} from './useCursorPagedList';
import { isRollbackableSkillVersion } from './writeOperation';

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

const Field = memo<{ label: string; value: ReactNode }>(({ label, value }) => (
  <Flexbox gap={3}>
    <Text type="secondary">{label}</Text>
    <Text>{value}</Text>
  </Flexbox>
));

Field.displayName = 'AdminSkillVersionField';

interface VersionsSectionProps {
  actionLoading: boolean;
  canRead: boolean;
  canRollback: boolean;
  onRollback: (versionId: string) => void;
  onSelect: (versionId: string) => void;
  selectedVersionId?: string;
  skillId: string;
}

export const VersionsSection = memo<VersionsSectionProps>(
  ({ actionLoading, canRead, canRollback, onRollback, selectedVersionId, skillId, onSelect }) => {
    const { t } = useTranslation('admin');
    const paging = useCursorStack();
    const versions = useFetchAdminSkillVersions(
      { cursor: paging.cursor, limit: PAGE_LIMIT, skillId },
      canRead,
    );

    return (
      <section className={skillDetailSectionStyles.section}>
        <Flexbox gap={3}>
          <Text strong as="h2">
            {t('skillCatalog.detail.versions.title')}
          </Text>
          <Text type="secondary">{t('skillCatalog.detail.versions.desc')}</Text>
        </Flexbox>
        <CursorPagedListSurface
          data={versions.data}
          error={versions.error}
          isLoading={versions.isLoading}
          pagination={{ hasPrevious: paging.hasPrevious }}
          labels={{
            empty: t('skillCatalog.detail.versions.empty'),
            error: t('skillCatalog.detail.versions.error'),
            loading: t('skillCatalog.detail.versions.loading'),
            pageError: t('skillCatalog.detail.versions.pageError'),
          }}
          renderItems={(items) =>
            items.map((version) => (
              <VersionRow
                actionLoading={actionLoading}
                canRollback={canRollback}
                key={version.id}
                selected={version.id === selectedVersionId}
                version={version}
                onRollback={onRollback}
                onSelect={onSelect}
              />
            ))
          }
          onNext={paging.goNext}
          onPrevious={paging.goPrevious}
          onRetry={() => void versions.mutate()}
        />
      </section>
    );
  },
);

VersionsSection.displayName = 'AdminSkillVersionsSection';

const VersionRow = memo<{
  actionLoading: boolean;
  canRollback: boolean;
  onRollback: (versionId: string) => void;
  onSelect: (versionId: string) => void;
  selected: boolean;
  version: AdminSkillVersionSummary;
}>(({ actionLoading, canRollback, onRollback, onSelect, selected, version }) => {
  const { t } = useTranslation('admin');
  const errors = version.validation?.issues.filter((issue) => issue.severity === 'error').length;
  const warnings = version.validation?.issues.filter(
    (issue) => issue.severity === 'warning',
  ).length;
  return (
    <div className={styles.version}>
      <Flexbox gap={2}>
        <Text strong>{version.version}</Text>
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
      {canRollback && isRollbackableSkillVersion(version) ? (
        <Button danger disabled={actionLoading} onClick={() => onRollback(version.id)}>
          {t('skillCatalog.actions.rollback.label')}
        </Button>
      ) : null}
    </div>
  );
});

VersionRow.displayName = 'AdminSkillVersionRow';

export const VersionDetail = memo<{
  data?: AdminSkillGetVersionOutput;
  error?: unknown;
  isLoading: boolean;
  onRetry: () => void;
  selectedVersionId?: string;
}>(({ data, error, isLoading, onRetry, selectedVersionId }) => {
  const { t } = useTranslation('admin');
  if (!selectedVersionId) {
    return (
      <section className={skillDetailSectionStyles.section}>
        <Text strong as="h2">
          {t('skillCatalog.detail.version.title')}
        </Text>
        <Empty description={t('skillCatalog.detail.version.select')} />
      </section>
    );
  }

  return (
    <section className={skillDetailSectionStyles.section}>
      <Text strong as="h2">
        {t('skillCatalog.detail.version.title')}
      </Text>
      <AsyncBoundary data={data} error={error} isLoading={isLoading} onRetry={onRetry}>
        {data ? (
          <>
            <div className={skillDetailSectionStyles.identityGrid}>
              <Field label={t('skillCatalog.detail.version.version')} value={data.version} />
              <Field
                label={t('skillCatalog.detail.version.createdAt')}
                value={formatAdminDateTime(data.createdAt)}
              />
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
                        <Text>
                          {t(`skillCatalog.validation.issue.${issue.code}` as never, {
                            path:
                              issue.path.length > 0
                                ? issue.path.join('.')
                                : t('skillCatalog.validation.path.root'),
                          })}
                        </Text>
                        <Text code type="secondary">
                          {issue.path.length ? issue.path.join('.') : '—'}
                        </Text>
                        <details>
                          <summary>{t('skillCatalog.validation.technicalDetails')}</summary>
                          <Text type="secondary">
                            {t('skillCatalog.validation.untranslatedDiagnostics')}
                          </Text>
                          <Text code>{issue.message}</Text>
                        </details>
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
