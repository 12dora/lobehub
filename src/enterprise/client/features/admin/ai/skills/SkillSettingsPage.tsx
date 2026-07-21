'use client';

import { Center, Empty, Flexbox, SearchBar, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { createStaticStyles, cssVar } from 'antd-style';
import { Link as LinkIcon } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import PlatformSkillItem from '@/routes/(main)/settings/skill/features/PlatformSkillItem';

import { deriveSkillPermissions } from '../../skills/controller';
import { refreshAdminSkillLists, useFetchAdminSkills } from '../../skills/hooks/useAdminSkills';
import { openCreateSkillModal } from '../../skills/openCreateSkillModal';
import type { AdminSkillListItem } from '../../skills/types';
import {
  AdminSkillDetailPanel,
  buildBuiltinSkillRows,
  BuiltinSkillDetailPanel,
  isBuiltinSkillId,
} from './AdminSkillDetailPanel';
import DraftPublishBanner from './DraftPublishBanner';
import { openAdminImportSkillModal } from './openAdminImportSkillModal';

const styles = createStaticStyles(({ css }) => ({
  advancedLink: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  content: css`
    overflow: auto;
    flex: 1;
    min-width: 0;
  `,
  left: css`
    overflow: hidden;
    display: flex;
    flex-direction: column;

    width: 300px;
    min-width: 260px;
    border-inline-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  leftBody: css`
    overflow-y: auto;
    flex: 1;
    padding-block: 4px;
    padding-inline: 8px;
  `,
  leftHeader: css`
    display: flex;
    flex-shrink: 0;
    gap: 8px;
    align-items: center;
    justify-content: space-between;

    height: 42px;
    padding-inline: 16px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
  `,
  shell: css`
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  `,
  toolbar: css`
    display: flex;
    flex-shrink: 0;
    gap: 12px;
    align-items: center;
    justify-content: space-between;

    padding-block: 8px 12px;
    padding-inline: 4px;
  `,
}));

const SkillListItem = memo<{
  isSelected: boolean;
  onSelect: () => void;
  skill: AdminSkillListItem;
}>(({ isSelected, onSelect, skill }) => (
  <PlatformSkillItem
    extraBadges={[skill.status]}
    isSelected={isSelected}
    translateBadges={false}
    skill={{
      displayName: skill.displayName,
      distribution: skill.distribution,
      source: skill.source,
    }}
    onSelect={onSelect}
  />
));

/**
 * Admin parity page for `/admin/ai/skills` (+ `/:id`).
 * Master-detail visual language aligned with user settings skills (PlatformSkill* style),
 * data from admin.skills list/get; mutations via applyImmediate / archive.
 */
const SkillSettingsPage = memo(() => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const { authMethod, permissions } = useAdminAccess();
  const { canCreate, canPublish, canRead } = deriveSkillPermissions(permissions);
  const [query, setQuery] = useState('');
  const listInput = useMemo(
    () => ({
      limit: 100,
      query: query.trim() || undefined,
    }),
    [query],
  );
  const { data, error, isLoading, mutate } = useFetchAdminSkills(listInput, canRead);
  const selectedId = params.id;
  // Merge code-bundled built-ins so they appear alongside DB drafts; a real DB
  // row (draft/published/archived override) shadows the built-in by skillKey.
  const items = useMemo(() => {
    const dbItems = data?.items ?? [];
    const dbKeys = new Set(dbItems.map((item) => item.skillKey));
    const q = query.trim().toLowerCase();
    const builtins = buildBuiltinSkillRows().filter((builtin) => {
      if (dbKeys.has(builtin.skillKey)) return false;
      if (!q) return true;
      return (
        builtin.displayName.toLowerCase().includes(q) ||
        builtin.skillKey.toLowerCase().includes(q) ||
        (builtin.description ?? '').toLowerCase().includes(q)
      );
    });
    return [...dbItems, ...builtins];
  }, [data?.items, query]);

  const onSelect = (id: string) => {
    navigate(`/admin/ai/skills/${encodeURIComponent(id)}`);
  };

  const submitCreate = async (input: Parameters<typeof adminSkillsService.applyImmediate>[0]) => {
    const result = await adminSkillsService.applyImmediate(input);
    await refreshAdminSkillLists();
    await mutate();
    if (result.published) {
      toast.success(
        t('aiSkillSettings.actions.published', { defaultValue: 'Skill listed for all users' }),
      );
    } else {
      toast.success(
        result.publishError ||
          t('aiSkillSettings.actions.draftSaved', {
            defaultValue: 'Skill saved as draft — add a version to list it',
          }),
      );
    }
    navigate(`/admin/ai/skills/${encodeURIComponent(result.draft.id)}`);
  };

  const onCreate = () => {
    openCreateSkillModal({
      authMethod,
      withVersionPayload: true,
      onSubmit: async (input) => {
        await submitCreate({
          ...input,
          mode: 'create',
        });
      },
    });
  };

  const onImport = () => {
    openAdminImportSkillModal({
      onSubmit: async (input) => {
        await submitCreate({
          ...input,
          mode: 'create',
        });
      },
    });
  };

  return (
    <div className={styles.shell}>
      <div className={styles.toolbar}>
        <div>
          <Text as="h1" style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
            {t('nav.aiSkills', { defaultValue: 'Skills' })}
          </Text>
          <Text style={{ fontSize: 12 }} type="secondary">
            {t('aiSkillSettings.description', {
              defaultValue:
                'Manage the global platform skill catalog. Listing publishes for all users.',
            })}
          </Text>
        </div>
        <Link className={styles.advancedLink} to="/admin/skills">
          {t('aiSkillSettings.advancedCatalog', {
            defaultValue: 'Advanced catalog management',
          })}
        </Link>
      </div>
      <div className={styles.body}>
        <div className={styles.left}>
          <div className={styles.leftHeader}>
            <Text strong style={{ fontSize: 14 }}>
              {t('nav.aiSkills', { defaultValue: 'Skills' })}
            </Text>
            {canCreate && canPublish ? (
              <Flexbox horizontal gap={6}>
                <Button
                  icon={LinkIcon}
                  size="small"
                  title={t('aiSkillSettings.import.title', {
                    defaultValue: 'Import skill from URL',
                  })}
                  onClick={onImport}
                />
                <Button size="small" type="primary" onClick={onCreate}>
                  {t('aiSkillSettings.actions.create', { defaultValue: 'List skill' })}
                </Button>
              </Flexbox>
            ) : null}
          </div>
          <div style={{ padding: '8px 12px' }}>
            <SearchBar
              allowClear
              placeholder={t('primitives.filterBar.searchPlaceholder')}
              value={query}
              onInputChange={setQuery}
              onSearch={setQuery}
            />
          </div>
          <div className={styles.leftBody}>
            {error && !data ? (
              <AsyncError error={error} variant="block" onRetry={() => void mutate()} />
            ) : isLoading && !data ? (
              <Loading debugId="Admin > Skills > List" />
            ) : items.length === 0 ? (
              <Center paddingBlock={32}>
                <Empty
                  icon={SkillsIcon}
                  title={t('aiSkillSettings.empty.title', { defaultValue: 'No skills' })}
                  description={t('aiSkillSettings.empty.desc', {
                    defaultValue: 'No platform skills yet. List one to make it available to users.',
                  })}
                />
              </Center>
            ) : (
              <Flexbox gap={4}>
                {items.map((skill) => (
                  <SkillListItem
                    isSelected={selectedId === skill.id}
                    key={skill.id}
                    skill={skill}
                    onSelect={() => onSelect(skill.id)}
                  />
                ))}
              </Flexbox>
            )}
          </div>
        </div>
        <div className={styles.content}>
          <div style={{ padding: '12px 24px 0' }}>
            <DraftPublishBanner
              activeSkillId={isBuiltinSkillId(selectedId) ? undefined : selectedId}
              onPublished={() => {
                void mutate();
                void refreshAdminSkillLists();
              }}
            />
          </div>
          {selectedId ? (
            isBuiltinSkillId(selectedId) ? (
              <BuiltinSkillDetailPanel key={selectedId} skillId={selectedId} />
            ) : (
              // Key by skill id so switching skills remounts the panel — otherwise its local
              // busy/pending/saveError state (and a stale Retry) leaks onto the next skill.
              <AdminSkillDetailPanel
                key={selectedId}
                skillId={selectedId}
                onChanged={() => {
                  void mutate();
                }}
              />
            )
          ) : (
            <Center paddingBlock={64}>
              <Empty
                icon={SkillsIcon}
                title={t('aiSkillSettings.select.title', { defaultValue: 'Select a skill' })}
                description={t('aiSkillSettings.select.desc', {
                  defaultValue: 'Select a skill from the list, or list a new one.',
                })}
              />
            </Center>
          )}
        </div>
      </div>
    </div>
  );
});

SkillSettingsPage.displayName = 'AdminSkillSettingsPage';

export default SkillSettingsPage;
