'use client';

import { Alert, Block, Flexbox, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { KeyedMutator } from 'swr';

import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { adminAgentsService } from '@/enterprise/client/services/adminAgents';
import { adminPlatformAgentDetailAggregateOutputSchema } from '@/server/enterprise/contracts/platformAgents';

import AdminPageTemplate from '../primitives/AdminPageTemplate';
import StatusBadge from '../primitives/StatusBadge';
import { AgentEditorFields } from './AgentEditorFields';
import { AssignmentPanel } from './AssignmentPanel';
import type { deriveAdminAgentPermissions } from './controller';
import { deriveAdminAgentActionAvailability } from './controller';
import { DependencyEditor, type DependencyValidity } from './DependencyEditor';
import { RolloutPanel } from './RolloutPanel';
import type { AdminAgentDetailOutput } from './types';
import { useAgentActions } from './useAgentActions';
import type { useAgentEditor } from './useAgentEditor';
import { useRefreshLock } from './useRefreshLock';
import {
  selectCurrentPlatformAgentVersion,
  selectLatestPlatformAgentVersion,
  sortPlatformAgentVersionsDesc,
} from './versionSelection';

interface AgentDetailViewProps {
  authMethod: AdminReauthAuthMethod | null;
  editor: ReturnType<typeof useAgentEditor>;
  mutate: KeyedMutator<AdminAgentDetailOutput>;
  permissions: ReturnType<typeof deriveAdminAgentPermissions>;
  pollError?: unknown;
  retryRolloutPoll?: () => Promise<unknown>;
  rolloutsEnabled?: boolean;
  snapshot: AdminAgentDetailOutput;
}

type CollectionKind = 'assignments' | 'rollouts' | 'versions';
type CollectionLoadState = Record<CollectionKind, 'error' | 'idle' | 'loading'>;

const PERSIST_HINT_KEY = {
  blocked: 'agentCatalog.recovery.blocked',
  invalid: 'agentCatalog.recovery.invalid',
  saved: 'agentCatalog.recovery.saved',
  too_large: 'agentCatalog.recovery.tooLarge',
  unavailable: 'agentCatalog.recovery.unavailable',
} as const;

// Statuses that warrant a visible warning (vs. the subtle "saved"/"pending" secondary text).
const PERSIST_WARNING = new Set(['blocked', 'too_large', 'unavailable']);

/**
 * A refreshed Agent detail unlocks the refresh gate ONLY when it FIRST parses as a COMPLETE
 * authoritative aggregate — full identity + draftToken + the assignments / versions / rollouts
 * collections — against the same contract Zod schema used at the API boundary (not a handwritten
 * partial shape), AND then demonstrably advances the CAS past the frozen baseline for the SAME
 * Agent: either `revision` OR `draftSequence` STRICTLY greater (monotone), never decreased, AND
 * the draftToken changed. Draft-only mutations (assignments, appendVersion, pinned rollout rollback)
 * advance `draftSequence` without touching published `revision`; requiring revision alone permanently
 * locks the detail page after those commits. A partial object, CAS rollback, token-only change with
 * equal sequences, another Agent, or an undefined/incomplete detail are all rejected.
 */
export const isAgentDetailFresh = (
  result: AdminAgentDetailOutput | undefined,
  baseline: AdminAgentDetailOutput | undefined,
): boolean => {
  // Must be a complete authoritative aggregate (identity, draftToken, assignments/versions/rollouts).
  const parsed = adminPlatformAgentDetailAggregateOutputSchema.safeParse(result);
  if (!parsed.success) return false;
  if (!baseline?.identity || typeof baseline.draftToken !== 'string') return false; // need a real baseline
  const fresh = parsed.data;
  if (fresh.identity.id !== baseline.identity.id) return false; // same Agent only
  // Neither CAS counter may go backwards.
  if (fresh.identity.revision < baseline.identity.revision) return false;
  if (fresh.identity.draftSequence < baseline.identity.draftSequence) return false;
  // At least one counter must strictly advance (draft-only commits only bump draftSequence).
  const advanced =
    fresh.identity.revision > baseline.identity.revision ||
    fresh.identity.draftSequence > baseline.identity.draftSequence;
  if (!advanced) return false;
  return fresh.draftToken !== baseline.draftToken; // the CAS token must also have changed
};

export const AgentDetailView = memo(
  ({
    authMethod,
    editor,
    mutate,
    permissions,
    pollError,
    retryRolloutPoll,
    rolloutsEnabled = false,
    snapshot,
  }: AgentDetailViewProps) => {
    const { t } = useTranslation('admin');
    const current = selectCurrentPlatformAgentVersion(snapshot);
    const latest = selectLatestPlatformAgentVersion(snapshot.versions);
    // Exact catalog validity of the draft dependencies, reported up by the DependencyEditor.
    // `ready` means the model/skill/connector refs still match the CURRENT published catalog.
    const [depValidity, setDepValidity] = useState<DependencyValidity>({
      issues: [],
      ready: false,
    });
    const onDepValidity = useCallback((value: DependencyValidity) => setDepValidity(value), []);
    const modelReady = depValidity.ready;
    const availability = deriveAdminAgentActionAvailability({
      dirty: editor.dirty,
      hasCurrentVersion: Boolean(latest),
      permissions,
    });
    // Shared refresh gate: a committed change whose refresh does NOT return a fresh, CAS-advanced
    // detail locks EVERY dependent write (agent actions + assignments) until refresh advances CAS.
    // The snapshot is read through a ref so the lock never compares against a stale closure.
    const snapshotRef = useRef(snapshot);
    snapshotRef.current = snapshot;
    const lock = useRefreshLock<AdminAgentDetailOutput>(mutate, {
      getSnapshot: () => snapshotRef.current,
      isFresh: isAgentDetailFresh,
    });
    const actions = useAgentActions({ authMethod, editor, lock, mutate, permissions, snapshot });
    const [collectionLoadState, setCollectionLoadState] = useState<CollectionLoadState>({
      assignments: 'idle',
      rollouts: 'idle',
      versions: 'idle',
    });
    const collectionLoadingRef = useRef<Record<CollectionKind, boolean>>({
      assignments: false,
      rollouts: false,
      versions: false,
    });

    const loadMoreCollection = useCallback(
      async (kind: CollectionKind) => {
        if (collectionLoadingRef.current[kind]) return;
        const meta = snapshot.collectionMeta;
        if (!meta) return;
        const cursorKey =
          kind === 'assignments'
            ? 'assignmentsNextCursor'
            : kind === 'rollouts'
              ? 'rolloutsNextCursor'
              : 'versionsNextCursor';
        const cursor = meta[cursorKey];
        if (!cursor) return;
        const agentId = snapshot.identity.id;
        collectionLoadingRef.current[kind] = true;
        setCollectionLoadState((current) => ({ ...current, [kind]: 'loading' }));
        try {
          // Separate awaits so each page.items type stays distinct (union would lose id/jobId).
          if (kind === 'assignments') {
            const page = await adminAgentsService.listAssignments({ agentId, cursor, limit: 100 });
            await mutate(
              (current): AdminAgentDetailOutput | undefined => {
                if (!current) return current;
                const baseMeta = current.collectionMeta ?? {
                  assignmentsNextCursor: null,
                  assignmentsTruncated: false,
                  rolloutsNextCursor: null,
                  rolloutsTruncated: false,
                  versionsNextCursor: null,
                  versionsTruncated: false,
                };
                const seen = new Set(current.assignments.map((row) => row.id));
                const appended = page.items.filter((item) => !seen.has(item.id));
                return {
                  ...current,
                  assignments: [...current.assignments, ...appended],
                  collectionMeta: {
                    ...baseMeta,
                    assignmentsNextCursor: page.nextCursor,
                    assignmentsTruncated: page.nextCursor !== null,
                  },
                };
              },
              { revalidate: false },
            );
          } else if (kind === 'rollouts') {
            const page = await adminAgentsService.listRollouts({ agentId, cursor, limit: 100 });
            await mutate(
              (current): AdminAgentDetailOutput | undefined => {
                if (!current) return current;
                const baseMeta = current.collectionMeta ?? {
                  assignmentsNextCursor: null,
                  assignmentsTruncated: false,
                  rolloutsNextCursor: null,
                  rolloutsTruncated: false,
                  versionsNextCursor: null,
                  versionsTruncated: false,
                };
                const seen = new Set(current.rollouts.map((row) => row.jobId));
                const appended = page.items.filter((item) => !seen.has(item.jobId));
                return {
                  ...current,
                  collectionMeta: {
                    ...baseMeta,
                    rolloutsNextCursor: page.nextCursor,
                    rolloutsTruncated: page.nextCursor !== null,
                  },
                  rollouts: [...current.rollouts, ...appended],
                };
              },
              { revalidate: false },
            );
          } else {
            const page = await adminAgentsService.listVersions({ agentId, cursor, limit: 100 });
            await mutate(
              (current): AdminAgentDetailOutput | undefined => {
                if (!current) return current;
                const baseMeta = current.collectionMeta ?? {
                  assignmentsNextCursor: null,
                  assignmentsTruncated: false,
                  rolloutsNextCursor: null,
                  rolloutsTruncated: false,
                  versionsNextCursor: null,
                  versionsTruncated: false,
                };
                const seen = new Set(current.versions.map((row) => row.id));
                const appended = page.items.filter((item) => !seen.has(item.id));
                return {
                  ...current,
                  collectionMeta: {
                    ...baseMeta,
                    versionsNextCursor: page.nextCursor,
                    versionsTruncated: page.nextCursor !== null,
                  },
                  versions: sortPlatformAgentVersionsDesc([
                    ...current.versions,
                    ...appended,
                  ] as AdminAgentDetailOutput['versions']),
                };
              },
              { revalidate: false },
            );
          }
          setCollectionLoadState((current) => ({ ...current, [kind]: 'idle' }));
        } catch {
          setCollectionLoadState((current) => ({ ...current, [kind]: 'error' }));
          toast.error(t('agentCatalog.collection.loadFailed'));
        } finally {
          collectionLoadingRef.current[kind] = false;
        }
      },
      [mutate, snapshot.collectionMeta, snapshot.identity.id, t],
    );

    return (
      <AdminPageTemplate
        description={snapshot.identity.agentKey}
        title={current?.config.displayName ?? snapshot.identity.agentKey}
        actions={
          <Flexbox horizontal gap={8} wrap="wrap">
            {availability.canSaveVersion && editor.draft ? (
              <Button
                type="primary"
                disabled={
                  !editor.dirty ||
                  editor.conflict ||
                  editor.saveState === 'saving' ||
                  !modelReady ||
                  lock.locked
                }
                onClick={actions.save}
              >
                {editor.saveState === 'saving'
                  ? t('agentCatalog.action.saving')
                  : t('agentCatalog.action.saveVersion')}
              </Button>
            ) : null}
            {permissions.canPublish &&
            latest &&
            (latest.id !== current?.id || snapshot.identity.status !== 'published') ? (
              <Button
                disabled={!availability.canPublishNow || lock.locked}
                onClick={() => actions.publish(latest.id)}
              >
                {t('agentCatalog.publish.submit')}
              </Button>
            ) : null}
            {permissions.canPublish &&
            !snapshot.identity.isDefault &&
            snapshot.identity.status === 'published' ? (
              <Button
                danger
                disabled={!availability.canPublishNow || lock.locked}
                onClick={() => void actions.setDefaultInbox()}
              >
                {t('agentCatalog.defaultSwitch.submit')}
              </Button>
            ) : null}
            {permissions.canDelete ? (
              <Button
                danger
                disabled={!availability.canArchiveNow || lock.locked}
                onClick={() => void actions.archive()}
              >
                {t('agentCatalog.archive.submit')}
              </Button>
            ) : null}
          </Flexbox>
        }
      >
        <Flexbox gap={24}>
          <Flexbox horizontal gap={8} wrap="wrap">
            <StatusBadge status={snapshot.identity.status} />
            {snapshot.identity.isDefault ? <Tag>{t('agentCatalog.defaultInbox')}</Tag> : null}
            {snapshot.identity.migrationRequired ? (
              <Tag color="warning">{t('agentCatalog.migrationRequired')}</Tag>
            ) : null}
            {!permissions.canUpdate ? <Tag>{t('agentCatalog.readOnly.badge')}</Tag> : null}
            <Text type="secondary">
              {t('agentCatalog.revision', { revision: snapshot.identity.revision })}
            </Text>
          </Flexbox>
          {actions.refreshFailed ? (
            <Alert
              showIcon
              description={t('agentCatalog.recovery.refreshFailedDescription')}
              message={t('agentCatalog.recovery.refreshFailed')}
              type="warning"
              action={
                <Button size="small" onClick={() => void actions.retryRefresh()}>
                  {t('agentCatalog.recovery.refreshRetry')}
                </Button>
              }
            />
          ) : null}
          {editor.conflict ? (
            <Alert
              description={t('agentCatalog.conflict.description')}
              message={t('agentCatalog.conflict.title')}
              type="error"
              action={
                <Button size="small" onClick={editor.discard}>
                  {t('agentCatalog.conflict.discard')}
                </Button>
              }
            />
          ) : null}
          {editor.saveState === 'failed' ? (
            <Alert message={t('agentCatalog.save.failed')} type="error" />
          ) : null}
          {editor.persistState && PERSIST_WARNING.has(editor.persistState) ? (
            <Alert showIcon message={t(PERSIST_HINT_KEY[editor.persistState])} type="warning" />
          ) : editor.persistState ? (
            <Text type="secondary">{t(PERSIST_HINT_KEY[editor.persistState])}</Text>
          ) : null}
          {editor.draft ? (
            <Block padding={20} variant="outlined">
              <Flexbox gap={20}>
                <AgentEditorFields
                  draft={editor.draft}
                  editable={permissions.canUpdate}
                  onChange={editor.updateDraft}
                />
                <DependencyEditor
                  agentId={snapshot.identity.id}
                  dependencies={editor.draft.dependencies}
                  editable={permissions.canUpdate}
                  enabled={permissions.canUpdate}
                  onValidityChange={onDepValidity}
                  onChange={(next) =>
                    editor.updateDraft((currentDraft) => ({
                      ...currentDraft,
                      dependencies: next,
                    }))
                  }
                />
                {permissions.canUpdate && depValidity.issues.length > 0 ? (
                  <Alert
                    showIcon
                    message={depValidity.issues.map((issue) => t(issue as never)).join(' · ')}
                    type="warning"
                  />
                ) : null}
              </Flexbox>
            </Block>
          ) : null}
          <Flexbox gap={12}>
            <Text as="h3" fontSize={16} weight={600}>
              {t('agentCatalog.versions.title')}
            </Text>
            {snapshot.collectionMeta?.versionsTruncated ? (
              <Alert
                showIcon
                description={t('agentCatalog.collection.truncatedVersions')}
                message={t('agentCatalog.collection.truncated')}
                type="warning"
                action={
                  snapshot.collectionMeta.versionsNextCursor ? (
                    <Button
                      loading={collectionLoadState.versions === 'loading'}
                      size="small"
                      onClick={() => void loadMoreCollection('versions')}
                    >
                      {t(
                        collectionLoadState.versions === 'error'
                          ? 'agentCatalog.collection.retry'
                          : 'agentCatalog.collection.loadMore',
                      )}
                    </Button>
                  ) : undefined
                }
              />
            ) : null}
            {snapshot.versions.length === 0 ? (
              <Text type="secondary">{t('agentCatalog.versions.empty')}</Text>
            ) : null}
            {snapshot.versions.map((version) => (
              <Block key={version.id} padding={16} variant="outlined">
                <Flexbox horizontal align="center" gap={12} justify="space-between" wrap="wrap">
                  <Flexbox gap={4}>
                    <Flexbox horizontal gap={8}>
                      <Text strong>{version.version}</Text>
                      {version.id === snapshot.identity.currentVersionId ? (
                        <Tag color="success">{t('agentCatalog.versions.current')}</Tag>
                      ) : null}
                    </Flexbox>
                    <Text type="secondary">
                      {version.dependencySnapshot.model.providerKey}/
                      {version.dependencySnapshot.model.modelKey} ·{' '}
                      {version.dependencySnapshot.skills.length} {t('agentCatalog.versions.skills')}{' '}
                      · {version.dependencySnapshot.connectors.length}{' '}
                      {t('agentCatalog.versions.connectors')}
                    </Text>
                    <Text code type="secondary">
                      {version.checksum.slice(0, 16)}…
                    </Text>
                  </Flexbox>
                  {permissions.canPublish &&
                  version.id !== snapshot.identity.currentVersionId &&
                  !(snapshot.identity.status === 'draft' && version.id === latest?.id) ? (
                    <Button
                      danger
                      disabled={!availability.canRollbackNow || lock.locked}
                      onClick={() => actions.rollback(version.id)}
                    >
                      {t('agentCatalog.rollback.submit')}
                    </Button>
                  ) : null}
                </Flexbox>
              </Block>
            ))}
          </Flexbox>
          <AssignmentPanel
            assignmentsTruncated={Boolean(snapshot.collectionMeta?.assignmentsTruncated)}
            authMethod={authMethod}
            loadMoreError={collectionLoadState.assignments === 'error'}
            loadingMore={collectionLoadState.assignments === 'loading'}
            lock={lock}
            permissions={permissions}
            refresh={mutate}
            rolloutsEnabled={rolloutsEnabled}
            snapshot={snapshot}
            onLoadMoreAssignments={
              snapshot.collectionMeta?.assignmentsNextCursor
                ? () => loadMoreCollection('assignments')
                : undefined
            }
          />
          <RolloutPanel
            authMethod={authMethod}
            enabled={rolloutsEnabled}
            loadMoreError={collectionLoadState.rollouts === 'error'}
            loadingMore={collectionLoadState.rollouts === 'loading'}
            lock={lock}
            permissions={permissions}
            pollError={pollError}
            refresh={mutate}
            retryPoll={retryRolloutPoll}
            rolloutsTruncated={Boolean(snapshot.collectionMeta?.rolloutsTruncated)}
            snapshot={snapshot}
            onLoadMoreRollouts={
              snapshot.collectionMeta?.rolloutsNextCursor
                ? () => loadMoreCollection('rollouts')
                : undefined
            }
          />
        </Flexbox>
      </AdminPageTemplate>
    );
  },
);

AgentDetailView.displayName = 'AgentDetailView';
