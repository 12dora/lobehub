'use client';

import { Flexbox, InputNumber, Tag, Text } from '@lobehub/ui';
import { Button, Modal, Select, Switch } from '@lobehub/ui/base-ui';
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

const DEFAULT_LIST_LIMIT = 50;
const POLL_MS = 4000;

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

const totalDeleted = (counts: AdminAuditRetentionRunItem['counts']) =>
  (counts.operationLogsDeleted ?? 0) +
  (counts.conversationsDeleted ?? 0) +
  (counts.messagesDeleted ?? 0) +
  (counts.topicsDeleted ?? 0) +
  (counts.sessionsDeleted ?? 0) +
  (counts.exportArtifactsDeleted ?? 0);

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
  const [cursorStack, setCursorStack] = useState<(string | null)[]>([]);
  const [limit, setLimit] = useState(DEFAULT_LIST_LIMIT);
  const [highlightIds, setHighlightIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<AdminAuditRetentionRunItem | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const runsRef = useRef<HTMLDivElement>(null);
  const currentCursor = cursorStack.at(-1) ?? null;

  const runs = useFetchAuditRetentionRuns({ cursor: currentCursor, limit }, canOperate, {
    refreshInterval: (latest) =>
      latest?.items?.some((i) => i.status === 'pending' || i.status === 'running') ? POLL_MS : 0,
  });
  const data = runs.data;
  const rows = data?.items ?? [];
  const mutate = runs.mutate;
  const isLoading = runs.isLoading;
  const error = runs.error;

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
            setHighlightIds(ids);
            setCursorStack([]);
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
    [authMethod, mutate, retentionDryRun, retentionRun, scope, t],
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
                {p.redactionProfile}
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
              <Descriptions.Item label={t('audit.retention.policy.revision')}>
                {p.revision}
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
                hasPrevious: cursorStack.length > 0,
                onNext: () => {
                  const next = data?.nextCursor;
                  if (next) setCursorStack((p) => [...p, next]);
                },
                onPrevious: () => setCursorStack((p) => p.slice(0, -1)),
                pageSize: limit,
                onPageSizeChange: (size) => {
                  setLimit(size);
                  setCursorStack([]);
                },
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
            await updatePolicy(input);
            setEditOpen(false);
            await refreshAuditPolicy();
          } catch (err) {
            // Always refresh so expectedRevision is no longer stale after conflict.
            await refreshAuditPolicy();
            // openReasonModal maps PLATFORM_REVISION_CONFLICT via getAdminUsersMutationErrorKey.
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
                  <td>{label}</td>
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

  // Sync local draft when policy loads / revision changes
  useEffect(() => {
    if (!policy || !open) return;
    setContentAccessMode(policy.contentAccessMode);
    setRedactionProfile(policy.redactionProfile);
    setConversationRetentionDays(policy.conversationRetentionDays);
    setOperationLogRetentionDays(policy.operationLogRetentionDays);
    setExportArtifactRetentionDays(policy.exportArtifactRetentionDays);
    setMaxListWindowDays(policy.maxListWindowDays);
    setMaxExportRows(policy.maxExportRows);
    setMessageBodyInExport(policy.messageBodyInExport);
  }, [open, policy]);

  const field = (label: string, control: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBlockEnd: 12 }}>
      <Text>{label}</Text>
      {control}
    </div>
  );

  const numberInput = (value: number, onChange: (n: number) => void, min: number, max: number) => (
    <InputNumber
      max={max}
      min={min}
      style={{ width: '100%' }}
      value={value}
      onChange={(v) => {
        const n = typeof v === 'number' ? v : Number(v);
        onChange(clampInt(n, min, max));
      }}
    />
  );

  const handleOk = () => {
    if (!policy) return;
    const fields = {
      contentAccessMode,
      conversationRetentionDays: clampInt(conversationRetentionDays, 1, 3650),
      exportArtifactRetentionDays: clampInt(exportArtifactRetentionDays, 1, 365),
      maxExportRows: clampInt(maxExportRows, 1, 1_000_000),
      maxListWindowDays: clampInt(maxListWindowDays, 1, 365),
      messageBodyInExport,
      operationLogRetentionDays: clampInt(operationLogRetentionDays, 1, 3650),
      redactionProfile,
    };

    const apply = () => {
      openAuditReasonModal({
        authMethod: authMethod ?? undefined,
        buildPayload: (reason) => ({
          ...fields,
          expectedRevision: policy.revision,
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
            { label: 'strict', value: 'strict' },
            { label: 'standard', value: 'standard' },
          ]}
          onChange={(v) => setRedactionProfile(v as AdminAuditPolicy['redactionProfile'])}
        />,
      )}
      {field(
        t('audit.retention.policy.conversationDays'),
        numberInput(conversationRetentionDays, setConversationRetentionDays, 1, 3650),
      )}
      {field(
        t('audit.retention.policy.operationLogDays'),
        numberInput(operationLogRetentionDays, setOperationLogRetentionDays, 1, 3650),
      )}
      {field(
        t('audit.retention.policy.exportArtifactDays'),
        numberInput(exportArtifactRetentionDays, setExportArtifactRetentionDays, 1, 365),
      )}
      {field(
        t('audit.retention.policy.maxListWindowDays'),
        numberInput(maxListWindowDays, setMaxListWindowDays, 1, 365),
      )}
      {field(
        t('audit.retention.policy.maxExportRows'),
        numberInput(maxExportRows, setMaxExportRows, 1, 1_000_000),
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
