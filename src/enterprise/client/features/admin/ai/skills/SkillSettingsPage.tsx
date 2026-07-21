'use client';

import { Center, Empty, Flexbox, SearchBar, Tag, Text } from '@lobehub/ui';
import { Button, confirmModal, toast } from '@lobehub/ui/base-ui';
import { SkillsIcon } from '@lobehub/ui/icons';
import { createStaticStyles, cssVar } from 'antd-style';
import { Link as LinkIcon } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import PlatformSkillItem from '@/routes/(main)/settings/skill/features/PlatformSkillItem';

import { deriveSkillPermissions, emptyEditableSkillVersionDraft } from '../../skills/controller';
import {
  refreshAdminSkillLists,
  useFetchAdminSkill,
  useFetchAdminSkills,
} from '../../skills/hooks/useAdminSkills';
import { openCreateSkillModal } from '../../skills/openCreateSkillModal';
import { openVersionEditorModal } from '../../skills/openVersionEditorModal';
import type { AdminSkillListItem } from '../../skills/types';
import { freezeSkillWriteSnapshot } from '../../skills/writeOperation';
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
  badges: css`
    display: flex;
    flex-shrink: 0;
    gap: 4px;
    padding-inline: 12px 8px;
  `,
  badge: css`
    padding-block: 1px;
    padding-inline: 5px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 999px;

    font-size: 10px;
    line-height: 16px;
    color: ${cssVar.colorTextSecondary};
  `,
  body: css`
    overflow: hidden;
    display: flex;
    flex: 1;
    min-height: 0;
  `,
  card: css`
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 10px 16px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
  `,
  content: css`
    overflow: auto;
    flex: 1;
    min-width: 0;
  `,
  detailBody: css`
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 24px;
  `,
  detailHeader: css`
    display: flex;
    flex-direction: column;
    gap: 6px;

    padding-block: 20px 16px;
    padding-inline: 24px;
    border-block-end: 1px solid ${cssVar.colorBorderSecondary};
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

const SkillDetailPanel = memo<{
  onArchived: () => void;
  onPublished: () => void;
  skillId: string;
}>(({ onArchived, onPublished, skillId }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canArchive, canPublish, canUpdate } = deriveSkillPermissions(permissions);
  const { data, error, isLoading, mutate } = useFetchAdminSkill(skillId, true);
  const [busy, setBusy] = useState(false);

  const canApply = canPublish && canUpdate;

  const onPublish = useCallback(async () => {
    if (!data) return;
    setBusy(true);
    try {
      const result = await adminSkillsService.applyImmediate({
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        mode: 'update',
        reason: 'Publish platform skill from admin settings',
      });
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
      await Promise.all([mutate(), refreshAdminSkillLists()]);
      onPublished();
    } catch {
      // toast already shown by service wrapper
    } finally {
      setBusy(false);
    }
  }, [data, mutate, onPublished, t]);

  const onAddVersion = useCallback(() => {
    if (!data) return;
    const initialDraft = emptyEditableSkillVersionDraft({
      content: `# ${data.draft.displayName}\n`,
      manifestText: JSON.stringify(
        {
          description: data.draft.description || data.draft.displayName,
          displayName: data.draft.displayName,
          localizedDescriptions: {},
          localizedDisplayNames: {},
          permissions: {
            filesystem: 'none',
            network: { allowedHosts: [], enabled: false },
            tools: { allow: [] },
          },
          skillDependencies: [],
          toolDependencies: [],
        },
        null,
        2,
      ),
    });
    openVersionEditorModal({
      initialDraft,
      onDraftChange: () => {},
      snapshot: freezeSkillWriteSnapshot(data),
      onSubmit: async (versionInput) => {
        const result = await adminSkillsService.applyImmediate({
          content: versionInput.content,
          contentRef: versionInput.contentRef,
          expectedDraftToken: versionInput.expectedDraftToken,
          expectedRevision: versionInput.expectedRevision,
          manifest: versionInput.manifest,
          mode: 'createVersion',
          reason: versionInput.reason,
          resources: versionInput.resources,
          skillId: versionInput.skillId,
          version: versionInput.version,
        });
        if (result.published) {
          toast.success(
            t('aiSkillSettings.actions.published', { defaultValue: 'Skill listed for all users' }),
          );
        } else {
          toast.success(
            result.publishError ||
              t('aiSkillSettings.actions.draftSaved', {
                defaultValue: 'Version saved as draft — fix validation then retry',
              }),
          );
        }
        await Promise.all([mutate(), refreshAdminSkillLists()]);
        onPublished();
      },
    });
  }, [data, mutate, onPublished, t]);

  const onArchive = useCallback(() => {
    if (!data) return;
    confirmModal({
      cancelText: t('users.modals.cancel'),
      content: t('aiSkillSettings.actions.archiveConfirmDesc', {
        defaultValue: 'Archive removes this skill from the live catalog for all users.',
        name: data.draft.displayName,
      }),
      okButtonProps: { danger: true },
      okText: t('aiSkillSettings.actions.archive', { defaultValue: 'Unlist' }),
      title: t('aiSkillSettings.actions.archiveConfirmTitle', {
        defaultValue: 'Unlist skill?',
      }),
      onOk: async () => {
        setBusy(true);
        try {
          await adminSkillsService.archiveImmediate({
            expectedDraftToken: data.draftToken,
            expectedRevision: data.baseRevision,
            id: data.draft.id,
            reason: 'Archive platform skill from admin settings',
          });
          toast.success(t('aiSkillSettings.actions.archived', { defaultValue: 'Skill unlisted' }));
          await Promise.all([mutate(), refreshAdminSkillLists()]);
          onArchived();
        } catch {
          // toast already shown by service wrapper
        } finally {
          setBusy(false);
        }
      },
    });
  }, [data, mutate, onArchived, t]);

  if (error && !data) {
    return <AsyncError error={error} variant="page" onRetry={() => void mutate()} />;
  }
  if (isLoading && !data) {
    return <Loading debugId="Admin > Skills > Detail" />;
  }
  if (!data) {
    return (
      <div className={styles.detailBody}>
        {t('aiSkillSettings.detail.notFound', { defaultValue: 'Skill not found' })}
      </div>
    );
  }

  const isLive = data.draft.status === 'published';
  const hasVersion = Boolean(data.latestVersion || data.publishedVersion);

  return (
    <>
      <header className={styles.detailHeader}>
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text strong as="h2">
            {data.draft.displayName}
          </Text>
          <Tag
            color={isLive ? 'success' : data.draft.status === 'archived' ? 'default' : 'warning'}
          >
            {data.draft.status}
          </Tag>
        </Flexbox>
        <Text type="secondary">
          {data.draft.description ||
            t('aiSkillSettings.detail.noDescription', { defaultValue: 'No description' })}
        </Text>
      </header>
      <main className={styles.detailBody}>
        <section className={styles.card}>
          <Text type="secondary">{t('skillCatalog.detail.identity.key')}</Text>
          <Text code>{data.draft.skillKey}</Text>
          <Text type="secondary">{t('skillCatalog.detail.identity.distribution')}</Text>
          <Text>{t(`skillCatalog.distribution.${data.draft.distribution}` as never)}</Text>
          <Text type="secondary">{t('skillCatalog.detail.identity.source')}</Text>
          <Text>{data.draft.source}</Text>
          <Text type="secondary">{t('skillCatalog.detail.identity.enabled')}</Text>
          <Text>{data.draft.enabled ? 'Yes' : 'No'}</Text>
          <Text type="secondary">
            {t('aiSkillSettings.detail.version', { defaultValue: 'Version' })}
          </Text>
          <Text>
            {data.publishedVersion?.version ??
              data.latestVersion?.version ??
              t('aiSkillSettings.detail.noVersion', { defaultValue: 'No version yet' })}
          </Text>
        </section>

        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
          {canUpdate ? (
            <Button disabled={busy} onClick={onAddVersion}>
              {t('aiSkillSettings.actions.addVersion', {
                defaultValue: 'Add / update version',
              })}
            </Button>
          ) : null}
          {canApply && !isLive ? (
            <Button
              disabled={!hasVersion || busy}
              loading={busy}
              type="primary"
              onClick={onPublish}
            >
              {t('aiSkillSettings.actions.publish', { defaultValue: 'List (publish)' })}
            </Button>
          ) : null}
          {canApply && isLive ? (
            <Button disabled={busy} loading={busy} type="primary" onClick={onPublish}>
              {t('aiSkillSettings.actions.republish', { defaultValue: 'Apply changes' })}
            </Button>
          ) : null}
          {canArchive && data.draft.status !== 'archived' ? (
            <Button danger disabled={busy} onClick={onArchive}>
              {t('aiSkillSettings.actions.archive', { defaultValue: 'Unlist' })}
            </Button>
          ) : null}
          <Link className={styles.advancedLink} to={`/admin/skills/${data.draft.id}`}>
            {t('aiSkillSettings.actions.editAdvanced', {
              defaultValue: 'Edit in advanced catalog',
            })}
          </Link>
        </Flexbox>
      </main>
    </>
  );
});

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
  const items = data?.items ?? [];

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
                <Button icon={LinkIcon} size="small" title="Import from URL" onClick={onImport} />
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
              activeSkillId={selectedId}
              onPublished={() => {
                void mutate();
                void refreshAdminSkillLists();
              }}
            />
          </div>
          {selectedId ? (
            <SkillDetailPanel
              skillId={selectedId}
              onArchived={() => {
                void mutate();
                navigate('/admin/ai/skills');
              }}
              onPublished={() => {
                void mutate();
              }}
            />
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
