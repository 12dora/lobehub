'use client';

import { Alert, Flexbox, InputNumber, Tag, Text } from '@lobehub/ui';
import { Button, Modal, Select, Switch, toast } from '@lobehub/ui/base-ui';
import { Descriptions, Drawer, Progress, type TableColumnsType } from 'antd';
import { createStaticStyles, cssVar } from 'antd-style';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PLATFORM_PERMISSIONS } from '@/const/platform/permissions';
import type { AdminReauthAuthMethod } from '@/enterprise/client/features/admin/reauth/requestAdminReauth';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminAuditPolicy,
  AdminAuditPolicyUpdateInput,
  AdminAuditRetentionCreateInput,
  AdminAuditRetentionRunItem,
} from '@/enterprise/client/services/adminAudit';

import AdminPageTemplate from '../../primitives/AdminPageTemplate';
import { openDangerConfirm } from '../../primitives/DangerConfirm';
import DataTable from '../../primitives/DataTable';
import {
  refreshAuditPolicy,
  useAdminAuditMutations,
  useFetchAuditPolicy,
  useFetchAuditRetentionRuns,
} from '../hooks/useAdminAudit';
import AuditStatusTag from '../shared/AuditStatusTag';
import { formatAdminDateTime, hasPermission } from '../shared/format';
import { openAuditReasonModal } from '../shared/openAuditReasonModal';
import { pollWhileInFlight, useCursorPagination } from '../shared/useCursorPagination';

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

const SCOPES = ['all', 'operation_logs', 'conversations', 'export_artifacts'] as const;

const CONTENT_ACCESS_MODE_KEYS = {
  content_allowed: 'audit.retention.policy.mode.content_allowed',
  disabled: 'audit.retention.policy.mode.disabled',
  metadata_only: 'audit.retention.policy.mode.metadata_only',
} as const;

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value) : min));

// Single source of truth for retention-policy field bounds, referenced by both the
// number inputs and the submit-time clamp so the two can never drift apart.
const POLICY_BOUNDS = {
  conversationRetentionDays: { max: 3650, min: 1 },
  exportArtifactRetentionDays: { max: 365, min: 1 },
  maxExportRows: { max: 1_000_000, min: 1 },
  maxListWindowDays: { max: 365, min: 1 },
  operationLogRetentionDays: { max: 3650, min: 1 },
} as const;
const clampField = (name: keyof typeof POLICY_BOUNDS, value: number) =>
  clampInt(value, POLICY_BOUNDS[name].min, POLICY_BOUNDS[name].max);

const totalDeleted = (counts: AdminAuditRetentionRunItem['counts']) =>
  (counts.operationLogsDeleted ?? 0) +
  (counts.conversationsDeleted ?? 0) +
  (counts.messagesDeleted ?? 0) +
  (counts.topicsDeleted ?? 0) +
  (counts.sessionsDeleted ?? 0) +
  (counts.exportArtifactsDeleted ?? 0);

const isRetentionRunInFlight = (status: AdminAuditRetentionRunItem['status']) =>
  status === 'pending' || status === 'running';

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
  const runsInitializedRef = useRef(false);

  const runs = useFetchAuditRetentionRuns({ cursor: currentCursor, limit }, canOperate, {
    refreshInterval: pollWhileInFlight(),
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
      if (
        runsInitializedRef.current &&
        previousStatus &&
        isRetentionRunInFlight(previousStatus) &&
        run.status === 'failed'
      ) {
        toast.error(
          t('audit.retention.runs.failureToast', {
            reason: retentionFailureMessage(run),
          }),
        );
      }
      runStatusesRef.current.set(run.id, run.status);
    }
    runsInitializedRef.current = true;

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

  const columns: TableColumnsType<AdminAuditRetentionRunItem> = useMemo(
    () => [
      {
        dataIndex: 'mode',
        key: 'mode',
        title: t('audit.retention.runs.mode'),
        width: 110,
        render: (v: string) => <AuditStatusTag kind="mode" value={v} />,
      },
      {
        dataIndex: 'scope',
        key: 'scope',
        title: t('audit.retention.runs.scope'),
        width: 140,
        render: (v: string) => t(`audit.retention.scope.${v}` as never, { defaultValue: v }),
      },
      {
        dataIndex: 'status',
        key: 'status',
        title: t('audit.retention.runs.status'),
        width: 110,
        render: (v: string) => <AuditStatusTag kind="retention" value={v} />,
      },
      {
        key: 'progress',
        title: t('audit.retention.runs.progress'),
        width: 160,
        render: (_, row) => {
          if (row.status !== 'running' && row.status !== 'pending') {
            return `${row.progressDone}${row.progressTotal != null ? ` / ${row.progressTotal}` : ''}`;
          }
          const pct =
            row.progressTotal && row.progressTotal > 0
              ? Math.round((row.progressDone / row.progressTotal) * 100)
              : 0;
          return <Progress percent={pct} size="small" />;
        },
      },
      {
        dataIndex: 'cutoffAt',
        key: 'cutoffAt',
        title: t('audit.retention.runs.cutoff'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        key: 'counts',
        title: t('audit.retention.runs.counts'),
        render: (_, row) => (
          <Flexbox horizontal gap={4} style={{ flexWrap: 'wrap' }}>
            <span>
              {t('audit.retention.runs.deleted')}: {totalDeleted(row.counts)}
            </span>
            {(row.counts.skippedLegalHold ?? 0) > 0 ? (
              <Tag color="warning" size="small">
                {t('audit.retention.runs.skippedHold', { count: row.counts.skippedLegalHold })}
              </Tag>
            ) : null}
          </Flexbox>
        ),
      },
      {
        dataIndex: 'requestedBy',
        key: 'requestedBy',
        title: t('audit.retention.runs.requestedBy'),
        width: 120,
      },
      {
        dataIndex: 'createdAt',
        key: 'createdAt',
        title: t('audit.retention.runs.createdAt'),
        width: 160,
        render: (v: Date) => formatAdminDateTime(v),
      },
      {
        key: 'actions',
        title: t('audit.retention.runs.actions'),
        width: 100,
        render: (_, row) =>
          row.status === 'pending' || row.status === 'running' ? (
            <Button danger size="small" onClick={() => onCancelRun(row)}>
              {t('audit.retention.runs.cancel')}
            </Button>
          ) : null,
      },
    ],
    [onCancelRun, t],
  );

  const p = policy.data;

  return (
    <AdminPageTemplate
      description={t('audit.retention.page.desc')}
      title={t('audit.retention.page.title')}
    >
      <div className={styles.section}>
        <div className={styles.card}>
          <Flexbox horizontal align="center" justify="space-between" style={{ marginBlockEnd: 12 }}>
            <Text style={{ fontWeight: 600 }}>{t('audit.retention.policy.title')}</Text>
            {canUpdatePolicy ? (
              <Button size="small" type="default" onClick={() => setEditOpen(true)}>
                {t('audit.retention.policy.edit')}
              </Button>
            ) : null}
          </Flexbox>
          {policy.error && !p ? (
            <Flexbox align="flex-start" gap={8}>
              <Text role="alert" type="danger">
                {t('audit.retention.policy.loadError')}
              </Text>
              <Button size="small" type="default" onClick={() => void policy.mutate()}>
                {t('primitives.dataTable.retry')}
              </Button>
            </Flexbox>
          ) : p ? (
            <Descriptions column={2} size="small">
              <Descriptions.Item label={t('audit.retention.policy.contentAccessMode')}>
                {t(CONTENT_ACCESS_MODE_KEYS[p.contentAccessMode])}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.redactionProfile')}>
                {t(`audit.retention.redaction.${p.redactionProfile}` as never, {
                  defaultValue: p.redactionProfile,
                })}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.conversationDays')}>
                {p.conversationRetentionDays}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.operationLogDays')}>
                {p.operationLogRetentionDays}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.exportArtifactDays')}>
                {p.exportArtifactRetentionDays}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.maxListWindowDays')}>
                {p.maxListWindowDays}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.maxExportRows')}>
                {p.maxExportRows}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.messageBodyInExport')}>
                {p.messageBodyInExport ? t('audit.shared.yes') : t('audit.shared.no')}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.updatedBy')}>
                {p.updatedBy ?? '—'}
              </Descriptions.Item>
              <Descriptions.Item label={t('audit.retention.policy.updatedAt')}>
                {formatAdminDateTime(p.updatedAt)}
              </Descriptions.Item>
            </Descriptions>
          ) : (
            <Text type="secondary">{t('primitives.dataTable.loading')}</Text>
          )}
        </div>

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

      <Drawer
        destroyOnClose
        open={Boolean(detail)}
        title={t('audit.retention.runs.detailTitle')}
        width={480}
        onClose={() => setDetail(null)}
      >
        {detail ? (
          <Flexbox gap={16}>
            {detail.status === 'failed' ? (
              <Alert
                showIcon
                description={retentionFailureMessage(detail)}
                message={t('audit.retention.runs.failureTitle')}
                type="error"
                action={
                  canOperate ? (
                    <Button
                      size="small"
                      onClick={() => {
                        setDetail(null);
                        startCleanup('dry_run');
                      }}
                    >
                      {t('audit.retention.runs.runDryCheck')}
                    </Button>
                  ) : null
                }
              />
            ) : null}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('audit.retention.runs.countMetric')}</th>
                  <th style={{ textAlign: 'right' }}>{t('audit.retention.runs.scanned')}</th>
                  <th style={{ textAlign: 'right' }}>{t('audit.retention.runs.deleted')}</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['operationLogs', 'operationLogsScanned', 'operationLogsDeleted'],
                    ['conversations', 'conversationsScanned', 'conversationsDeleted'],
                    ['messages', 'messagesScanned', 'messagesDeleted'],
                    ['topics', 'topicsScanned', 'topicsDeleted'],
                    ['sessions', 'sessionsScanned', 'sessionsDeleted'],
                    ['exportArtifacts', 'exportArtifactsScanned', 'exportArtifactsDeleted'],
                  ] as const
                ).map(([label, scanned, deleted]) => (
                  <tr key={label}>
                    <td>{t(`audit.retention.runs.metric.${label}` as never)}</td>
                    <td style={{ textAlign: 'right' }}>{detail.counts[scanned] ?? 0}</td>
                    <td style={{ textAlign: 'right' }}>{detail.counts[deleted] ?? 0}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2}>{t('audit.retention.runs.skippedHoldLabel')}</td>
                  <td style={{ textAlign: 'right' }}>{detail.counts.skippedLegalHold ?? 0}</td>
                </tr>
              </tbody>
            </table>
          </Flexbox>
        ) : null}
      </Drawer>
    </AdminPageTemplate>
  );
});

const PolicyEditModal = memo<{
  authMethod?: AdminReauthAuthMethod | null;
  onClose: () => void;
  onSubmit: (input: AdminAuditPolicyUpdateInput) => Promise<void>;
  open: boolean;
  policy?: AdminAuditPolicy;
}>(({ open, onClose, policy, onSubmit, authMethod }) => {
  const { t } = useTranslation('admin');
  const [contentAccessMode, setContentAccessMode] =
    useState<AdminAuditPolicy['contentAccessMode']>('metadata_only');
  const [redactionProfile, setRedactionProfile] =
    useState<AdminAuditPolicy['redactionProfile']>('standard');
  const [conversationRetentionDays, setConversationRetentionDays] = useState(90);
  const [operationLogRetentionDays, setOperationLogRetentionDays] = useState(90);
  const [exportArtifactRetentionDays, setExportArtifactRetentionDays] = useState(30);
  const [maxListWindowDays, setMaxListWindowDays] = useState(30);
  const [maxExportRows, setMaxExportRows] = useState(100_000);
  const [messageBodyInExport, setMessageBodyInExport] = useState(false);
  const [hasConflict, setHasConflict] = useState(false);
  const initializedOpenRef = useRef(false);
  const latestRevisionRef = useRef<number | null>(null);

  // Populate once per open session. Later policy refreshes advance only the retry
  // revision and preserve the operator's local draft for review.
  useEffect(() => {
    if (!open) {
      initializedOpenRef.current = false;
      latestRevisionRef.current = null;
      setHasConflict(false);
      return;
    }
    if (!policy) return;

    if (!initializedOpenRef.current) {
      initializedOpenRef.current = true;
      latestRevisionRef.current = policy.revision;
      setContentAccessMode(policy.contentAccessMode);
      setRedactionProfile(policy.redactionProfile);
      setConversationRetentionDays(policy.conversationRetentionDays);
      setOperationLogRetentionDays(policy.operationLogRetentionDays);
      setExportArtifactRetentionDays(policy.exportArtifactRetentionDays);
      setMaxListWindowDays(policy.maxListWindowDays);
      setMaxExportRows(policy.maxExportRows);
      setMessageBodyInExport(policy.messageBodyInExport);
      setHasConflict(false);
      return;
    }

    if (latestRevisionRef.current !== policy.revision) {
      latestRevisionRef.current = policy.revision;
      setHasConflict(true);
    }
  }, [open, policy]);

  const field = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 12 }}>
      <Text>{label}</Text>
      {control}
    </div>
  );

  const numberInput = (
    value: number,
    onChange: (n: number) => void,
    bounds: { max: number; min: number },
  ) => (
    <InputNumber
      max={bounds.max}
      min={bounds.min}
      style={{ width: '100%' }}
      value={value}
      onChange={(v) => {
        const n = typeof v === 'number' ? v : Number(v);
        onChange(clampInt(n, bounds.min, bounds.max));
      }}
    />
  );

  const handleOk = () => {
    if (!policy) return;
    const fields = {
      contentAccessMode,
      conversationRetentionDays: clampField('conversationRetentionDays', conversationRetentionDays),
      exportArtifactRetentionDays: clampField(
        'exportArtifactRetentionDays',
        exportArtifactRetentionDays,
      ),
      maxExportRows: clampField('maxExportRows', maxExportRows),
      maxListWindowDays: clampField('maxListWindowDays', maxListWindowDays),
      messageBodyInExport,
      operationLogRetentionDays: clampField('operationLogRetentionDays', operationLogRetentionDays),
      redactionProfile,
    };

    const apply = () => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          ...fields,
          expectedRevision: latestRevisionRef.current ?? policy.revision,
          reason,
        }),
        description: t('audit.retention.policy.reasonDesc'),
        onSubmit: async (payload) => {
          await onSubmit(payload as AdminAuditPolicyUpdateInput);
          onClose();
        },
        submitLabel: t('audit.retention.policy.save'),
        targetLabel: `rev ${policy.revision}`,
        title: t('audit.retention.policy.edit'),
      });
    };

    if (
      fields.contentAccessMode === 'content_allowed' &&
      policy.contentAccessMode !== 'content_allowed'
    ) {
      openDangerConfirm({
        content: t('audit.retention.policy.contentAllowedWarn'),
        title: t('audit.retention.policy.contentAllowedWarnTitle'),
        onConfirm: apply,
      });
    } else {
      apply();
    }
  };

  return (
    <Modal
      okText={t('audit.retention.policy.save')}
      open={open}
      title={t('audit.retention.policy.edit')}
      width={560}
      onCancel={onClose}
      onOk={handleOk}
    >
      {hasConflict ? (
        <Alert
          showIcon
          description={t('audit.retention.policy.conflictDescription')}
          message={t('audit.retention.policy.conflictTitle')}
          type="warning"
        />
      ) : null}
      {field(
        t('audit.retention.policy.contentAccessMode'),
        <Select
          style={{ width: '100%' }}
          value={contentAccessMode}
          options={[
            { label: t('audit.retention.policy.mode.disabled'), value: 'disabled' },
            { label: t('audit.retention.policy.mode.metadata_only'), value: 'metadata_only' },
            { label: t('audit.retention.policy.mode.content_allowed'), value: 'content_allowed' },
          ]}
          onChange={(v) => setContentAccessMode(v as AdminAuditPolicy['contentAccessMode'])}
        />,
      )}
      {field(
        t('audit.retention.policy.redactionProfile'),
        <Select
          style={{ width: '100%' }}
          value={redactionProfile}
          options={[
            { label: t('audit.retention.redaction.strict'), value: 'strict' },
            { label: t('audit.retention.redaction.standard'), value: 'standard' },
          ]}
          onChange={(v) => setRedactionProfile(v as AdminAuditPolicy['redactionProfile'])}
        />,
      )}
      {field(
        t('audit.retention.policy.conversationDays'),
        numberInput(
          conversationRetentionDays,
          setConversationRetentionDays,
          POLICY_BOUNDS.conversationRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.operationLogDays'),
        numberInput(
          operationLogRetentionDays,
          setOperationLogRetentionDays,
          POLICY_BOUNDS.operationLogRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.exportArtifactDays'),
        numberInput(
          exportArtifactRetentionDays,
          setExportArtifactRetentionDays,
          POLICY_BOUNDS.exportArtifactRetentionDays,
        ),
      )}
      {field(
        t('audit.retention.policy.maxListWindowDays'),
        numberInput(maxListWindowDays, setMaxListWindowDays, POLICY_BOUNDS.maxListWindowDays),
      )}
      {field(
        t('audit.retention.policy.maxExportRows'),
        numberInput(maxExportRows, setMaxExportRows, POLICY_BOUNDS.maxExportRows),
      )}
      {field(
        t('audit.retention.policy.messageBodyInExport'),
        <Switch
          checked={messageBodyInExport}
          onChange={(v) => setMessageBodyInExport(Boolean(v))}
        />,
      )}
    </Modal>
  );
});

RetentionPage.displayName = 'AuditRetentionPage';

export default RetentionPage;
