'use client';

import { builtinSkills as bundledBuiltinSkills } from '@lobechat/builtin-skills';
import { Flexbox, Tag, Text } from '@lobehub/ui';
import { Segmented, Switch, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import type { PlatformSkillDistribution } from '@/types/platform/skills';

import { deriveSkillPermissions } from '../../skills/controller';
import { refreshAdminSkillLists, useFetchAdminSkill } from '../../skills/hooks/useAdminSkills';
import type { AdminSkillListItem } from '../../skills/types';

/** Synthetic id prefix for code-bundled built-in skills (no platform DB row). */
export const BUILTIN_ID_PREFIX = 'builtin:';

export const isBuiltinSkillId = (id: string | undefined): id is string =>
  Boolean(id?.startsWith(BUILTIN_ID_PREFIX));

/**
 * Build read-only list rows for the code-bundled built-in skills so the admin
 * catalog shows the same built-ins the user Settings > Skill page does. These
 * are always live in the runtime; a real DB draft/override shadows them (see the
 * dedupe by skillKey in the page). Uses the full bundled set to match the
 * server's unfiltered built-in catalog.
 */
export const buildBuiltinSkillRows = (): AdminSkillListItem[] =>
  bundledBuiltinSkills.map((skill) => ({
    allowBuiltinOverride: false,
    currentVersionId: null,
    description: skill.description ?? null,
    displayName: skill.name,
    distribution: 'default',
    draftSequence: 0,
    enabled: true,
    id: `${BUILTIN_ID_PREFIX}${skill.identifier}`,
    revision: 0,
    skillKey: skill.identifier,
    source: 'builtin',
    status: 'published',
  }));

/** Reason recorded on the audit trail for org-default distribution changes. */
const ORG_DEFAULT_REASON = 'Set organization skill default from admin settings';

/** Segmented order reads off → on → forced (least to most enforcement). */
const DISTRIBUTION_ORDER: readonly PlatformSkillDistribution[] = [
  'optional',
  'default',
  'mandatory',
];

const styles = createStaticStyles(({ css }) => ({
  advancedLink: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-decoration: none;

    &:hover {
      color: ${cssVar.colorTextSecondary};
    }
  `,
  card: css`
    display: grid;
    grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
    gap: 12px 16px;
    align-items: center;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
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
}));

/**
 * Read-only detail for a code-bundled built-in skill. Built-ins have no DB draft,
 * so their org default is not editable here — they are always available to all
 * users by default. Shown as a disabled, on switch for parity with the editable
 * skills, never a lifecycle editor.
 */
export const BuiltinSkillDetailPanel = memo<{ skillId: string }>(({ skillId }) => {
  const { t } = useTranslation('admin');
  const skill = bundledBuiltinSkills.find((s) => `${BUILTIN_ID_PREFIX}${s.identifier}` === skillId);

  if (!skill) {
    return (
      <div className={styles.detailBody}>
        {t('aiSkillSettings.detail.notFound', { defaultValue: 'Skill not found' })}
      </div>
    );
  }

  return (
    <>
      <header className={styles.detailHeader}>
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text strong as="h2">
            {skill.name}
          </Text>
          <Tag color="processing">
            {t('aiSkillSettings.builtin.tag', { defaultValue: 'Built-in' })}
          </Tag>
        </Flexbox>
        <Text type="secondary">
          {skill.description ||
            t('aiSkillSettings.detail.noDescription', { defaultValue: 'No description' })}
        </Text>
      </header>
      <main className={styles.detailBody}>
        <section className={styles.card}>
          <Text type="secondary">{t('skillCatalog.detail.identity.source')}</Text>
          <Text>{skill.source}</Text>
          <Text type="secondary">{t('skillCatalog.detail.identity.distribution')}</Text>
          <Text>{t('skillCatalog.distribution.default')}</Text>
          <Text type="secondary">
            {t('aiSkillSettings.orgDefault.label', { defaultValue: 'Enabled by default' })}
          </Text>
          <Flexbox horizontal align="center" gap={8}>
            <Switch checked disabled />
            <Text type="secondary">
              {t('aiSkillSettings.builtin.note', {
                defaultValue:
                  'Built-in skills are provided by the platform and available to all users by default — no listing needed.',
              })}
            </Text>
          </Flexbox>
        </section>
      </main>
    </>
  );
});

BuiltinSkillDetailPanel.displayName = 'AdminBuiltinSkillDetailPanel';

interface AdminSkillDetailPanelProps {
  /** Called after a successful org-default change so the list can refresh. */
  onChanged: () => void;
  skillId: string;
}

/**
 * Settings-panel detail for a DB-backed platform skill. Mirrors the user managed
 * skill detail (identity card + a single primary toggle), but the toggle sets the
 * ORG-WIDE DEFAULT (the skill's `distribution`) for every user rather than a
 * per-user agent config:
 *   - Switch ON  → `default`  (on by default for all users, still user-overridable)
 *   - Switch OFF → `optional` (off by default, users may opt in)
 *   - Segmented  → full 3-way, including `mandatory` (forced on, non-overridable)
 * Lifecycle authoring (versions / publish / unlist) lives in the advanced catalog.
 */
export const AdminSkillDetailPanel = memo<AdminSkillDetailPanelProps>(({ onChanged, skillId }) => {
  const { t } = useTranslation('admin');
  const { permissions } = useAdminAccess();
  const { canPublish, canUpdate } = deriveSkillPermissions(permissions);
  const canManage = canPublish && canUpdate;
  const { data, error, isLoading, mutate } = useFetchAdminSkill(skillId, true);
  const [busy, setBusy] = useState(false);
  // Optimistic override: reflect the pending distribution immediately, revert on error.
  const [pending, setPending] = useState<PlatformSkillDistribution | null>(null);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [failedTarget, setFailedTarget] = useState<PlatformSkillDistribution | null>(null);

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

  const distribution = pending ?? data.draft.distribution;
  const isMandatory = distribution === 'mandatory';
  const enabledByDefault = distribution !== 'optional';
  const version = data.publishedVersion?.version ?? data.latestVersion?.version ?? null;
  const checksum = data.publishedVersion?.checksum ?? data.latestVersion?.checksum ?? null;

  const setDistribution = async (next: PlatformSkillDistribution) => {
    if (!canManage || !data || next === data.draft.distribution) return;
    setBusy(true);
    setPending(next);
    setSaveError(null);
    setFailedTarget(null);
    let saved = false;
    try {
      const result = await adminSkillsService.applyImmediate({
        distribution: next,
        expectedDraftToken: data.draftToken,
        expectedRevision: data.baseRevision,
        id: data.draft.id,
        mode: 'update',
        reason: ORG_DEFAULT_REASON,
      });
      saved = true;
      if (result.published) {
        toast.success(
          t('aiSkillSettings.orgDefault.saved', { defaultValue: 'Organization default updated' }),
        );
      } else {
        toast.success(
          result.publishError ||
            t('aiSkillSettings.actions.draftSaved', {
              defaultValue: 'Skill saved as draft — add a version to list it',
            }),
        );
      }
    } catch (err) {
      // Hard failures already toast via the service wrapper; keep an inline retry.
      setSaveError(err instanceof Error ? err : new Error(String(err)));
      setFailedTarget(next);
    }
    // The change is already persisted server-side; revalidate best-effort so a mere refresh
    // failure is never misclassified as a save failure (which would offer a spurious Retry
    // that then OCC-conflicts against the already-applied change).
    if (saved) {
      await Promise.allSettled([mutate(), refreshAdminSkillLists()]);
      onChanged();
    }
    setPending(null);
    setBusy(false);
  };

  return (
    <>
      <header className={styles.detailHeader}>
        <Flexbox horizontal align="center" gap={8} justify="space-between">
          <Text strong as="h2">
            {data.draft.displayName}
          </Text>
          {isMandatory ? (
            <Tag color="warning">{t('skillCatalog.distribution.mandatory')}</Tag>
          ) : null}
        </Flexbox>
        <Text type="secondary">
          {data.draft.description ||
            t('aiSkillSettings.detail.noDescription', { defaultValue: 'No description' })}
        </Text>
      </header>
      <main className={styles.detailBody}>
        {saveError && failedTarget ? (
          <AsyncError
            error={saveError}
            variant="block"
            onRetry={() => void setDistribution(failedTarget)}
          />
        ) : null}
        <section className={styles.card}>
          <Text type="secondary">{t('skillCatalog.detail.identity.source')}</Text>
          <Text>{data.draft.source}</Text>
          <Text type="secondary">{t('skillCatalog.detail.identity.distribution')}</Text>
          <Text>{t(`skillCatalog.distribution.${distribution}` as never)}</Text>
          <Text type="secondary">
            {t('aiSkillSettings.detail.version', { defaultValue: 'Version' })}
          </Text>
          <Text>
            {version ?? t('aiSkillSettings.detail.noVersion', { defaultValue: 'No version yet' })}
          </Text>
          <Text type="secondary">{t('skillCatalog.detail.version.checksum')}</Text>
          <Text code>{checksum ?? '—'}</Text>

          <Text type="secondary">
            {t('aiSkillSettings.orgDefault.label', { defaultValue: 'Enabled by default' })}
          </Text>
          <Flexbox horizontal align="center" gap={8}>
            <Switch
              checked={enabledByDefault}
              disabled={!canManage || isMandatory || busy}
              onChange={(checked) => void setDistribution(checked ? 'default' : 'optional')}
            />
            <Text type="secondary">
              {isMandatory
                ? t('aiSkillSettings.orgDefault.mandatoryHint', {
                    defaultValue:
                      'Mandatory — always on for every user and cannot be turned off. Change the policy to relax.',
                  })
                : t('aiSkillSettings.orgDefault.useHint', {
                    defaultValue:
                      'On by default for all users. Users can still turn it off unless the policy is mandatory.',
                  })}
            </Text>
          </Flexbox>

          <Text type="secondary">
            {t('aiSkillSettings.orgDefault.policy', { defaultValue: 'Availability policy' })}
          </Text>
          <Segmented<PlatformSkillDistribution>
            disabled={!canManage || busy}
            value={distribution}
            options={DISTRIBUTION_ORDER.map((value) => ({
              label: t(`skillCatalog.distribution.${value}` as never),
              value,
            }))}
            onChange={(value) => void setDistribution(value)}
          />
        </section>

        <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
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

AdminSkillDetailPanel.displayName = 'AdminSkillDetailPanel';
