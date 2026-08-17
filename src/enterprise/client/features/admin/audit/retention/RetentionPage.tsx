'use client';

import { Flexbox, Text } from '@lobehub/ui';
import { Button, Select, toast } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminAuditRetentionCreateInput,
  AdminAuditRetentionRunItem,
} from '@/enterprise/client/services/adminAudit';
import { useVisiblePoll } from '@/enterprise/client/shared/useVisiblePoll';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { openDangerConfirm } from '../../primitives/DangerConfirm';
import DataTable from '../../primitives/DataTable';
import {
  refreshAuditPolicy,
  useAdminAuditMutations,
  useFetchAuditPolicy,
  useFetchAuditRetentionRuns,
} from '../hooks/useAdminAudit';
import { hasPermission } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import {
  AUDIT_LIST_POLL_MS,
  pollWhileInFlight,
  useCursorPagination,
} from '../shared/useCursorPagination';
import { isRetentionRunInFlight, SCOPES } from './policyBounds';
import PolicyEditModal from './PolicyEditModal';
import PolicySummaryCard from './PolicySummaryCard';
import RunDetailDrawer from './RunDetailDrawer';
import { useRetentionRunColumns } from './useRetentionRunColumns';

const styles = createStaticStyles(({ css }) => ({
  card: css`
    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};
    background: ${cssVar.colorBgContainer};
  `,
  section: css`
    display: flex;
    flex-direction: column;
    gap: 12px;

    @keyframes audit-highlight-fade {
      0% {
        background: ${cssVar.colorPrimaryBg};
        box-shadow: inset 0 0 0 2px ${cssVar.colorPrimary};
      }

      100% {
        background: transparent;
        box-shadow: none;
      }
    }
  `,
}));

const RetentionPage = memo(() => {
  const { t } = useTranslation('admin');
  const { permissions, authMethod } = useAdminAccess();
  const canOperate = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_RETENTION_OPERATE);
  const canUpdatePolicy = hasPermission(permissions, PLATFORM_PERMISSIONS.AUDIT_POLICY_UPDATE);
  const { updatePolicy, retentionDryRun, retentionRun, cancelRetentionRun } =
    useAdminAuditMutations();

  // policy.get is AUDIT_READ-class; operate/update roles already imply read on this page.
  const policy = useFetchAuditPolicy(canOperate || canUpdatePolicy);
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('all');
  const {
    currentCursor,
    hasPrevious,
    limit,
    onNext,
    onPageSizeChange,
    onPrevious,
    reset: resetCursor,
  } = useCursorPagination();
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<AdminAuditRetentionRunItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const runsRef = useRef<HTMLDivElement>(null);
  const runStatusesRef = useRef(new Map<string, AdminAuditRetentionRunItem['status']>());

  // Poll only while a run is in flight, and only while the tab is visible.
  const inFlightPollMs = useVisiblePoll(AUDIT_LIST_POLL_MS);
  const runs = useFetchAuditRetentionRuns({ cursor: currentCursor, limit }, canOperate, {
    refreshInterval: pollWhileInFlight(inFlightPollMs),
  });
  const data = runs.data;
  const rows = data?.items ?? [];
  const mutate = runs.mutate;
  const isLoading = runs.isLoading;
  const error = runs.error;

  const retentionFailureMessage = useCallback(
    (run: AdminAuditRetentionRunItem) =>
      t(`audit.retention.runs.error.${run.error?.code ?? 'unknown'}` as never, {
        defaultValue: t('audit.retention.runs.error.unknown'),
      }),
    [t],
  );

  useEffect(() => {
    if (!data) return;

    for (const run of data.items) {
      const previousStatus = runStatusesRef.current.get(run.id);
      if (previousStatus && isRetentionRunInFlight(previousStatus) && run.status === 'failed') {
        toast.error(
          t('audit.retention.runs.failureToast', {
            reason: retentionFailureMessage(run),
          }),
        );
      }
      runStatusesRef.current.set(run.id, run.status);
    }

    setDetail((current) => {
      if (!current) return current;
      return data.items.find((run) => run.id === current.id) ?? current;
    });
  }, [data, retentionFailureMessage, t]);

  const startCleanup = useCallback(
    (mode: 'dry_run' | 'execute') => {
      const run = async () => {
        openAuditReasonModal({
          authMethod: authMethod ?? undefined,
          buildPayload: (reason) => ({ reason, scope }) satisfies AdminAuditRetentionCreateInput,
          danger: mode === 'execute',
          description:
            mode === 'execute'
              ? t('audit.retention.cleanup.executeDesc')
              : t('audit.retention.cleanup.dryRunDesc'),
          impact: mode === 'execute' ? t('audit.retention.cleanup.executeImpact') : undefined,
          onSubmit: async (payload) => {
            const input = payload as AdminAuditRetentionCreateInput;
            const result =
              mode === 'execute' ? await retentionRun(input) : await retentionDryRun(input);
            const ids = result.items.map((i) => i.id);
            for (const item of result.items) {
              runStatusesRef.current.set(item.id, item.status);
            }
            setHighlightIds(ids);
            resetCursor();
            void mutate();
            // Scroll runs table into view; row highlight is applied via rowClassName.
            window.setTimeout(() => {
              runsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
          },
          submitLabel:
            mode === 'execute'
              ? t('audit.retention.cleanup.executeSubmit')
              : t('audit.retention.cleanup.dryRunSubmit'),
          targetLabel: t(`audit.retention.scope.${scope}` as never, { defaultValue: scope }),
          title:
            mode === 'execute'
              ? t('audit.retention.cleanup.executeTitle')
              : t('audit.retention.cleanup.dryRunTitle'),
        });
      };

      if (mode === 'execute') {
        openDangerConfirm({
          content: t('audit.retention.cleanup.executeConfirm'),
          title: t('audit.retention.cleanup.executeTitle'),
          onConfirm: () => {
            void run();
          },
        });
      } else {
        void run();
      }
    },
    [authMethod, mutate, resetCursor, retentionDryRun, retentionRun, scope, t],
  );

  const onCancelRun = useCallback(
    (row: AdminAuditRetentionRunItem) => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({ id: row.id, reason }),
        danger: true,
        onSubmit: async (payload) => {
          await cancelRetentionRun(payload as { id: string; reason: string });
          void mutate();
        },
        submitLabel: t('audit.retention.runs.cancel'),
        targetLabel: row.id,
        title: t('audit.retention.runs.cancelTitle'),
      });
    },
    [authMethod, cancelRetentionRun, mutate, t],
  );

  const columns = useRetentionRunColumns({ onCancelRun });

  const p = policy.data;

  return (
    <AdminPageTemplate
      description={t('audit.retention.page.desc')}
      title={t('audit.retention.page.title')}
    >
      <div className={styles.section}>
        <PolicySummaryCard
          canUpdatePolicy={canUpdatePolicy}
          error={policy.error}
          policy={p}
          onEdit={() => setEditOpen(true)}
          onRetry={() => void policy.mutate()}
        />

        {canOperate ? (
          <div className={styles.card}>
            <Text style={{ fontWeight: 600 }}>{t('audit.retention.cleanup.title')}</Text>
            <Flexbox horizontal gap={12} style={{ flexWrap: 'wrap', marginBlockStart: 12 }}>
              <Select
                style={{ width: 220 }}
                value={scope}
                options={SCOPES.map((s) => ({
                  label: t(`audit.retention.scope.${s}` as never),
                  value: s,
                }))}
                onChange={(v) => setScope(v as (typeof SCOPES)[number])}
              />
              <Button type="primary" onClick={() => startCleanup('dry_run')}>
                {t('audit.retention.cleanup.dryRun')}
              </Button>
              <Button danger type="primary" onClick={() => startCleanup('execute')}>
                {t('audit.retention.cleanup.execute')}
              </Button>
            </Flexbox>
          </div>
        ) : null}

        <div className={styles.card} ref={runsRef}>
          <Text style={{ fontWeight: 600 }}>{t('audit.retention.runs.title')}</Text>
          <div style={{ marginBlockStart: 12 }}>
            <DataTable<AdminAuditRetentionRunItem>
              columns={columns}
              dataSource={rows}
              emptyDescription={t('audit.retention.runs.empty')}
              error={Boolean(error) && !data}
              loading={isLoading && !data}
              pagination={false}
              rowKey="id"
              scroll={{ x: 1200 }}
              cursorPagination={{
                hasNext: Boolean(data?.nextCursor),
                hasPrevious,
                onNext: () => onNext(data?.nextCursor),
                onPrevious,
                pageSize: limit,
                onPageSizeChange,
              }}
              onRetry={() => void mutate()}
              onRowActivate={(row) => setDetail(row)}
            />
            {/* Highlight newly created runs (class applied via rowKey match below). */}
            {highlightIds.length > 0 ? (
              <style>{`
                ${highlightIds.map((id) => `[data-row-key="${id}"]`).join(',')} {
                  animation: audit-highlight-fade 2.4s ease-out;
                }
              `}</style>
            ) : null}
          </div>
          {highlightIds.length > 0 ? (
            <Text style={{ marginBlockStart: 8 }} type="secondary">
              {t('audit.retention.runs.highlighted', { ids: highlightIds.join(', ') })}
            </Text>
          ) : null}
        </div>
      </div>

      <PolicyEditModal
        authMethod={authMethod}
        open={editOpen}
        policy={p}
        onClose={() => setEditOpen(false)}
        onSubmit={async (input) => {
          try {
            // updatePolicy soft-refreshes on success; do not rethrow refresh failures.
            await updatePolicy(input);
            setEditOpen(false);
          } catch (err) {
            // Genuine mutation failure (e.g. revision conflict): resync expectedRevision.
            try {
              await refreshAuditPolicy();
            } catch (refreshError) {
              console.error(
                '[audit retention] Failed to refresh policy after conflict',
                refreshError,
              );
            }
            throw err;
          }
        }}
      />

      <RunDetailDrawer
        canOperate={canOperate}
        detail={detail}
        retentionFailureMessage={retentionFailureMessage}
        onClose={() => setDetail(null)}
        onRunDryCheck={() => {
          setDetail(null);
          startCleanup('dry_run');
        }}
      />
    </AdminPageTemplate>
  );
});

RetentionPage.displayName = 'AuditRetentionPage';

export default RetentionPage;
