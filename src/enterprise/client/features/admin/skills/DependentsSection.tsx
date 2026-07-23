'use client';

import { Flexbox, Tag, Text } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useFetchAdminSkillDependents } from './hooks/useAdminSkills';
import {
  CursorPagedListSurface,
  skillDetailSectionStyles,
  useCursorStack,
} from './useCursorPagedList';

const PAGE_LIMIT = 20;

const styles = createStaticStyles(({ css }) => ({
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
}));

export const DependentsSection = memo<{
  canRead: boolean;
  skillId: string;
  versionId?: string;
}>(({ canRead, skillId, versionId }) => {
  const { t } = useTranslation('admin');
  // Scope change (skill or selected version) must reset the cursor stack to page 1.
  const paging = useCursorStack(`${skillId}:${versionId ?? ''}`);
  const input = useMemo(
    () => ({ cursor: paging.cursor, limit: PAGE_LIMIT, skillId, versionId }),
    [paging.cursor, skillId, versionId],
  );
  const dependents = useFetchAdminSkillDependents(input, canRead);

  return (
    <section className={skillDetailSectionStyles.section}>
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
      <CursorPagedListSurface
        data={dependents.data}
        error={dependents.error}
        isLoading={dependents.isLoading}
        pagination={{ hasPrevious: paging.hasPrevious }}
        labels={{
          empty: t('skillCatalog.detail.dependents.empty'),
          error: t('skillCatalog.detail.dependents.error'),
          loading: t('skillCatalog.detail.dependents.loading'),
          pageError: t('skillCatalog.detail.dependents.pageError'),
        }}
        renderItems={(items) =>
          items.map((item) => (
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
          ))
        }
        onNext={paging.goNext}
        onPrevious={paging.goPrevious}
        onRetry={() => void dependents.mutate()}
      />
    </section>
  );
});

DependentsSection.displayName = 'AdminSkillDependentsSection';
