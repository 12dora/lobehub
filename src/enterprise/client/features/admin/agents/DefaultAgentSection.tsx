'use client';

import { Avatar, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { DEFAULT_AVATAR } from '@/const/meta';

import StatusBadge from '../primitives/StatusBadge';
import type { AdminDefaultAgentSnapshot } from './useAdminAgents';

const styles = createStaticStyles(({ css }) => ({
  identity: css`
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  `,
  meta: css`
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  `,
  metaText: css`
    font-family: ${cssVar.fontFamilyCode};
    font-size: ${cssVar.fontSizeSM};
    color: ${cssVar.colorTextTertiary};
  `,
  root: css`
    padding: 16px;
  `,
}));

export interface DefaultAgentSectionProps {
  /** AGENT_UPDATE or AGENT_ASSIGN — the same gate the table rows use to open the editor. */
  canEdit: boolean;
  /** AGENT_CREATE + AGENT_PUBLISH: provisioning writes a published Agent. */
  canProvision: boolean;
  error: unknown;
  onEdit: (agentId: string) => void;
  onProvision: () => void;
  /** Re-run the pointer read after a failed revalidation left a cached card on screen. */
  onRetry: () => void;
  provisioning: boolean;
  /** Undefined until the pointer read settles; `null` once it settles with no managed default. */
  snapshot: AdminDefaultAgentSnapshot | null | undefined;
}

/**
 * The 默认助理 pinned above the catalog table.
 *
 * The default assistant is the one every member meets first, and it is exactly one row — burying
 * it in a paginated, searchable table hides the highest-leverage thing on this page. Pinned here
 * it is always visible, and the table below never repeats it.
 */
export const DefaultAgentSection = memo<DefaultAgentSectionProps>(
  ({ canEdit, canProvision, error, onEdit, onProvision, onRetry, provisioning, snapshot }) => {
    const { t } = useTranslation('admin');

    // A failed revalidation on top of a settled read is no reason to hide the assistant every
    // member is already talking to: keep the last known state, say it may be behind, and offer the
    // retry. Only a read that never settled has nothing to show, and that alone is terminal.
    const stale = Boolean(error) && snapshot !== undefined;

    const body = () => {
      if (snapshot === undefined) {
        if (error) return <Text type={'danger'}>{t('agentCatalog.defaultAgent.loadError')}</Text>;
        return <Text type={'secondary'}>{t('agentCatalog.defaultAgent.loading')}</Text>;
      }

      if (!snapshot) {
        return (
          <Flexbox align={'flex-start'} gap={12}>
            <Text type={'secondary'}>{t('agentCatalog.defaultAgent.empty.description')}</Text>
            {canProvision ? (
              <Button loading={provisioning} type={'primary'} onClick={onProvision}>
                {t('agentCatalog.defaultAgent.provision.action')}
              </Button>
            ) : (
              <Text type={'secondary'}>{t('agentCatalog.defaultAgent.empty.readOnly')}</Text>
            )}
          </Flexbox>
        );
      }

      const { detail, item } = snapshot;
      // Avatar and model live on the published version, not on the list row.
      const version = detail?.versions.find(({ id }) => id === item.identity.currentVersionId);
      const model = version?.dependencySnapshot.model;

      return (
        <Flexbox horizontal align={'center'} gap={16} justify={'space-between'} wrap={'wrap'}>
          <Flexbox horizontal align={'center'} gap={12} style={{ minWidth: 0 }}>
            <Avatar
              avatar={version?.config.avatar ?? DEFAULT_AVATAR}
              background={version?.config.backgroundColor ?? undefined}
              shape={'square'}
              size={44}
            />
            <div className={styles.identity}>
              <Text ellipsis weight={600}>
                {item.displayName}
              </Text>
              <span className={styles.meta}>
                <StatusBadge status={item.identity.status} />
                <Tag size={'small'}>
                  {item.publishedVersion
                    ? t('agentCatalog.defaultAgent.version', { version: item.publishedVersion })
                    : t('agentCatalog.defaultAgent.unpublished')}
                </Tag>
                <span className={styles.metaText}>
                  {model
                    ? `${model.providerKey} · ${model.modelKey}`
                    : t('agentCatalog.defaultAgent.modelUnknown')}
                </span>
              </span>
            </div>
          </Flexbox>
          {canEdit ? (
            <Button type={'primary'} onClick={() => onEdit(item.identity.id)}>
              {t('agentCatalog.action.edit')}
            </Button>
          ) : null}
        </Flexbox>
      );
    };

    return (
      <Block className={styles.root} gap={12} variant={'outlined'}>
        <Flexbox gap={2}>
          <Text weight={600}>{t('agentCatalog.defaultAgent.title')}</Text>
          <Text type={'secondary'}>{t('agentCatalog.defaultAgent.description')}</Text>
        </Flexbox>
        {stale ? (
          <Flexbox horizontal align={'center'} gap={8} wrap={'wrap'}>
            <Text type={'warning'}>{t('agentCatalog.defaultAgent.loadError')}</Text>
            <Button size={'small'} onClick={onRetry}>
              {t('agentCatalog.dependency.retry')}
            </Button>
          </Flexbox>
        ) : null}
        {body()}
      </Block>
    );
  },
);

DefaultAgentSection.displayName = 'DefaultAgentSection';
