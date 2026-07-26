'use client';

import { ActionIcon, Flexbox, Tag, Text, Tooltip } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { ArrowDownIcon, ArrowUpIcon, PencilIcon, TrashIcon } from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AiCatalogPermissions } from '../controller';
import type { AdminAiModelDraft } from '../types';

const styles = createStaticStyles(({ css }) => ({
  actions: css`
    display: flex;
    gap: 4px;
    align-items: center;
  `,
  empty: css`
    padding: 32px;
    color: ${cssVar.colorTextSecondary};
    text-align: center;
  `,
  header: css`
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  `,
  item: css`
    display: grid;
    grid-template-columns: minmax(220px, 1fr) 100px 100px 140px;
    gap: 12px;
    align-items: center;

    padding: 12px;
    border-block-start: 1px solid ${cssVar.colorBorderSecondary};

    transition:
      opacity ${cssVar.motionDurationFast} ${cssVar.motionEaseInOut},
      background-color ${cssVar.motionDurationFast} ${cssVar.motionEaseInOut};

    &[data-loading='true'] {
      opacity: 0.72;
      background: ${cssVar.colorFillQuaternary};
    }

    @media (width <= 900px) {
      grid-template-columns: 1fr;
    }
  `,
  root: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 12px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
}));

export interface ProviderModelsSectionProps {
  actionLoadingId?: string | null;
  models: AdminAiModelDraft[];
  onCreate?: () => void;
  onDelete?: (model: AdminAiModelDraft) => void;
  onEdit?: (model: AdminAiModelDraft) => void;
  onReorder?: (orderedIds: string[]) => void;
  permissions: AiCatalogPermissions;
}

const ProviderModelsSection = memo<ProviderModelsSectionProps>(
  ({ actionLoadingId, models, onCreate, onDelete, onEdit, onReorder, permissions }) => {
    const { t } = useTranslation('admin');
    const sorted = useMemo(
      () => [...models].sort((a, b) => a.sort - b.sort || a.modelKey.localeCompare(b.modelKey)),
      [models],
    );

    const move = (index: number, offset: -1 | 1) => {
      const target = index + offset;
      if (target < 0 || target >= sorted.length || !onReorder) return;
      const ids = sorted.map((item) => item.id);
      [ids[index], ids[target]] = [ids[target]!, ids[index]!];
      onReorder(ids);
    };

    return (
      <section className={styles.root}>
        <div className={styles.header}>
          <Flexbox gap={2}>
            <Text strong>{t('aiCatalog.models.providerSection.title')}</Text>
            <Text type="secondary">{t('aiCatalog.models.providerSection.desc')}</Text>
          </Flexbox>
          {permissions.canCreateModel && onCreate ? (
            <Button onClick={onCreate}>{t('aiCatalog.models.actions.create')}</Button>
          ) : null}
        </div>

        {sorted.length === 0 ? (
          <div className={styles.empty}>{t('aiCatalog.models.empty.provider')}</div>
        ) : (
          sorted.map((model, index) => {
            const loading = actionLoadingId === 'models' || actionLoadingId === model.id;
            return (
              <div className={styles.item} data-loading={loading} key={model.id}>
                <Flexbox gap={2}>
                  <Text strong>{model.displayName || model.modelKey}</Text>
                  <Text type="secondary">{model.modelKey}</Text>
                </Flexbox>
                <Text>{t(`aiCatalog.modelTypes.${model.type}` as never)}</Text>
                <Tag color={model.enabled ? 'success' : 'default'}>
                  {t(`aiCatalog.common.boolean.${model.enabled}` as never)}
                </Tag>
                <div className={styles.actions}>
                  {permissions.canReorderModels && onReorder ? (
                    <>
                      <Tooltip title={t('aiCatalog.models.actions.moveUp')}>
                        <ActionIcon
                          disabled={loading || index === 0}
                          icon={ArrowUpIcon}
                          loading={loading}
                          size="small"
                          onClick={() => move(index, -1)}
                        />
                      </Tooltip>
                      <Tooltip title={t('aiCatalog.models.actions.moveDown')}>
                        <ActionIcon
                          disabled={loading || index === sorted.length - 1}
                          icon={ArrowDownIcon}
                          loading={loading}
                          size="small"
                          onClick={() => move(index, 1)}
                        />
                      </Tooltip>
                    </>
                  ) : null}
                  {permissions.canUpdateModel && onEdit ? (
                    <Tooltip title={t('aiCatalog.models.actions.edit')}>
                      <ActionIcon
                        disabled={loading}
                        icon={PencilIcon}
                        size="small"
                        onClick={() => onEdit(model)}
                      />
                    </Tooltip>
                  ) : null}
                  {permissions.canDeleteModel && onDelete ? (
                    <Tooltip title={t('aiCatalog.models.actions.delete')}>
                      <ActionIcon
                        disabled={loading}
                        icon={TrashIcon}
                        size="small"
                        onClick={() => onDelete(model)}
                      />
                    </Tooltip>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </section>
    );
  },
);

ProviderModelsSection.displayName = 'AdminAiProviderModelsSection';

export default ProviderModelsSection;
