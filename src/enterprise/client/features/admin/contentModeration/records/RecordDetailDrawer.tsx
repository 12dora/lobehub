'use client';

import { Flexbox, Skeleton, Tag, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { Drawer } from 'antd';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useAdminUserMutations } from '../../users/hooks/useAdminUsers';
import { openBanUserModal, openUnbanUserModal } from '../../users/modals/actions';
import { formatAdminDateTime } from '../../users/utils';
import {
  categoryLabel,
  decisionSourceLabel,
  displayModerationUser,
  formatLatency,
  formatModelPair,
  formatScore,
  policyActionLabel,
  requestKindLabel,
} from '../format';
import { invalidateModerationRecords, useModerationRecord } from '../hooks';
import ManageGuard from '../ManageGuard';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import type { ModerationRecordDetail } from '../types';
import ActionTag from './ActionTag';
import CategoryScoreBars from './CategoryScoreBars';

export interface RecordDetailDrawerProps {
  canBanUsers: boolean;
  canManage: boolean;
  onClose: () => void;
  open: boolean;
  recordId: string | null;
}

const Field = memo<{ children: React.ReactNode; label: string }>(({ children, label }) => (
  <div className={styles.fieldRow}>
    <Text className={styles.fieldLabel} type="secondary">
      {label}
    </Text>
    <div className={styles.fieldValue}>{children}</div>
  </div>
));
Field.displayName = 'ModerationDetailField';

const Section = memo<{ children: React.ReactNode; title: string }>(({ children, title }) => (
  <Flexbox gap={8} style={{ marginBlockEnd: 20 }}>
    <Text strong>{title}</Text>
    {children}
  </Flexbox>
));
Section.displayName = 'ModerationDetailSection';

/**
 * Record detail (design §6.2). Four questions in order: what was the request, why was it
 * judged that way, what was the text, and what was done about the user.
 */
const RecordDetailDrawer = memo<RecordDetailDrawerProps>(
  ({ canBanUsers, canManage, onClose, open, recordId }) => {
    const { t } = useTranslation('admin');
    const { authMethod } = useAdminAccess();
    const navigate = useNavigate();
    const { banUser, unbanUser } = useAdminUserMutations();
    const { data, error, isLoading, mutate } = useModerationRecord(open, recordId);
    const [fullPrompt, setFullPrompt] = useState<string | null>(null);
    const [revealing, setRevealing] = useState(false);

    // Never carry a revealed prompt across records — it is the most sensitive thing here.
    useEffect(() => {
      setFullPrompt(null);
    }, [recordId]);

    const record: ModerationRecordDetail | undefined = data;
    // `getRecord` returns the live user row; the snapshot is only the fallback for a user that
    // has since been deleted. Preferring the snapshot would show a stale name after a rename.
    const identity = record
      ? {
          email: record.user?.email ?? record.userSnapshot?.email ?? null,
          fullName: record.user?.fullName ?? record.userSnapshot?.fullName ?? null,
          username: record.user?.username ?? record.userSnapshot?.username ?? null,
        }
      : null;

    const handleReveal = () => {
      if (!record || !canManage || revealing) return;
      openDangerConfirm({
        content: t('contentModeration.records.revealConfirm'),
        title: t('contentModeration.records.revealTitle'),
        onConfirm: async () => {
          setRevealing(true);
          try {
            await runAdminMutation({
              authMethod,
              mapErrorKey: () => 'contentModeration.toast.revealFailed',
              run: async () => {
                const result = await adminContentModerationService.revealRecordPrompt({
                  id: record.id,
                });
                setFullPrompt(result.prompt);
              },
            });
          } finally {
            setRevealing(false);
          }
        },
      });
    };

    const handleDelete = () => {
      if (!record || !canManage) return;
      openDangerConfirm({
        content: t('contentModeration.records.deleteOneConfirm'),
        title: t('contentModeration.records.deleteTitle'),
        onConfirm: async () => {
          const ok = await runAdminMutation({
            authMethod,
            mapErrorKey: () => 'contentModeration.toast.deleteFailed',
            run: async () => {
              await adminContentModerationService.deleteRecords({ ids: [record.id] });
              toast.success(t('contentModeration.toast.deleteSuccess', { count: 1 }));
            },
          });
          if (ok) {
            await invalidateModerationRecords();
            onClose();
          }
        },
      });
    };

    const userLabel = record ? displayModerationUser(identity, record.userId) : '—';
    const userDeleted = Boolean(record?.userId) && record?.user === null;

    return (
      <Drawer
        destroyOnClose
        open={open}
        title={t('contentModeration.records.detailTitle')}
        width={Math.min(760, typeof window === 'undefined' ? 760 : window.innerWidth - 48)}
        extra={
          record ? (
            <ManageGuard allowed={canManage}>
              <Button danger disabled={!canManage} size="small" onClick={handleDelete}>
                {t('contentModeration.records.deleteRecord')}
              </Button>
            </ManageGuard>
          ) : null
        }
        onClose={onClose}
      >
        {isLoading && !record ? (
          // Same loading primitive as the rest of the admin surface — antd `Spin` is not used here.
          <Flexbox gap={12} role="status">
            <Skeleton.Block height={24} width="40%" />
            <Skeleton.Block height={160} width="100%" />
            <Skeleton.Block height={120} width="100%" />
          </Flexbox>
        ) : null}
        {error && !record ? (
          <Flexbox gap={8}>
            <Text type="danger">{t('contentModeration.records.detailLoadError')}</Text>
            <div>
              <Button size="small" onClick={() => void mutate()}>
                {t('contentModeration.charts.retry')}
              </Button>
            </div>
          </Flexbox>
        ) : null}

        {record ? (
          <>
            <Section title={t('contentModeration.records.sectionBasic')}>
              <Field label={t('contentModeration.records.columns.time')}>
                {formatAdminDateTime(record.createdAt)}
              </Field>
              <Field label={t('contentModeration.records.columns.user')}>
                {record.userId && !userDeleted ? (
                  <Button
                    size="small"
                    type="text"
                    onClick={() => navigate(`/admin/users/${record.userId}`)}
                  >
                    {userLabel}
                  </Button>
                ) : (
                  <span data-testid="record-user-label">
                    {userLabel}
                    {userDeleted ? ` · ${t('contentModeration.records.userDeleted')}` : ''}
                  </span>
                )}
              </Field>
              <Field label={t('contentModeration.records.columns.requestId')}>
                {record.requestId ?? '—'}
              </Field>
              <Field label={t('contentModeration.records.topic')}>
                {[record.topicId, record.messageId].filter(Boolean).join(' / ') || '—'}
              </Field>
              <Field label={t('contentModeration.records.columns.requestKind')}>
                {requestKindLabel(t, record.requestKind)}
              </Field>
              <Field label={t('contentModeration.records.requestedModel')}>
                {formatModelPair(record.provider, record.model)}
              </Field>
              <Field label={t('contentModeration.records.effectiveModel')}>
                {formatModelPair(record.effectiveProvider, record.effectiveModel)}
              </Field>
            </Section>

            <Section title={t('contentModeration.records.sectionDecision')}>
              <Field label={t('contentModeration.records.columns.action')}>
                <ActionTag
                  effectiveAction={record.effectiveAction}
                  policyAction={record.policyAction}
                />
              </Field>
              <Field label={t('contentModeration.records.policyAction')}>
                {policyActionLabel(t, record.policyAction)}
              </Field>
              <Field label={t('contentModeration.records.columns.source')}>
                {decisionSourceLabel(t, record.source)}
              </Field>
              <Field label={t('contentModeration.records.matchedRule')}>
                {record.matchedRule ? (
                  <code className={styles.code}>{record.matchedRule.pattern}</code>
                ) : (
                  '—'
                )}
              </Field>
              <Field label={t('contentModeration.records.columns.topCategory')}>
                {record.topCategory ? (
                  <>
                    {categoryLabel(t, record.topCategory)} · {formatScore(record.topScore)}
                  </>
                ) : (
                  '—'
                )}
              </Field>
              <Field label={t('contentModeration.records.columns.latency')}>
                {formatLatency(record.classifierLatencyMs)}
              </Field>
              {record.error ? (
                <Field label={t('contentModeration.records.error')}>
                  <Text type="danger">{record.error}</Text>
                </Field>
              ) : null}
              <CategoryScoreBars
                scores={record.categoryScores}
                thresholds={record.thresholdSnapshot}
              />
            </Section>

            <Section title={t('contentModeration.records.sectionContent')}>
              <Text type="secondary">{t('contentModeration.records.excerptHint')}</Text>
              <pre className={styles.excerpt}>{record.promptExcerpt || '—'}</pre>
              {record.hasFullPrompt ? (
                fullPrompt === null ? (
                  <Flexbox gap={8}>
                    <Text type="secondary">{t('contentModeration.records.revealHint')}</Text>
                    <div>
                      <ManageGuard allowed={canManage}>
                        <Button
                          disabled={!canManage}
                          loading={revealing}
                          size="small"
                          onClick={handleReveal}
                        >
                          {t('contentModeration.records.reveal')}
                        </Button>
                      </ManageGuard>
                    </div>
                  </Flexbox>
                ) : (
                  <pre className={styles.excerpt}>{fullPrompt}</pre>
                )
              ) : null}
              {record.revealedAt ? (
                <Text className={styles.hintText}>
                  {t('contentModeration.records.revealedAt', {
                    time: formatAdminDateTime(record.revealedAt),
                    user: record.revealedBy ?? '—',
                  })}
                </Text>
              ) : null}
            </Section>

            <Section title={t('contentModeration.records.sectionDisposition')}>
              <Field label={t('contentModeration.records.violationCount')}>
                {record.violationCount}
              </Field>
              <Field label={t('contentModeration.records.autoBanned')}>
                {record.autoBanned ? (
                  <Tag color="red" size="small">
                    {t('contentModeration.records.autoBannedYes')}
                  </Tag>
                ) : (
                  t('contentModeration.records.autoBannedNo')
                )}
              </Field>
              <Field label={t('contentModeration.records.notified')}>
                {record.notified
                  ? t('contentModeration.records.notifiedYes')
                  : t('contentModeration.records.notifiedNo')}
              </Field>
              {record.userId ? (
                <Flexbox horizontal gap={8} style={{ flexWrap: 'wrap' }}>
                  <ManageGuard allowed={canBanUsers} reasonKey="contentModeration.needUserBan">
                    <Button
                      danger
                      disabled={!canBanUsers || userDeleted}
                      size="small"
                      onClick={() =>
                        openBanUserModal({
                          authMethod: authMethod ?? undefined,
                          onConfirm: banUser,
                          targetLabel: userLabel,
                          userId: record.userId!,
                        })
                      }
                    >
                      {t('contentModeration.records.banUser')}
                    </Button>
                  </ManageGuard>
                  <ManageGuard allowed={canBanUsers} reasonKey="contentModeration.needUserBan">
                    <Button
                      disabled={!canBanUsers || userDeleted}
                      size="small"
                      onClick={() =>
                        openUnbanUserModal({
                          authMethod: authMethod ?? undefined,
                          onConfirm: unbanUser,
                          targetLabel: userLabel,
                          userId: record.userId!,
                        })
                      }
                    >
                      {t('contentModeration.records.unbanUser')}
                    </Button>
                  </ManageGuard>
                </Flexbox>
              ) : null}
            </Section>
          </>
        ) : null}
      </Drawer>
    );
  },
);

RecordDetailDrawer.displayName = 'ModerationRecordDetailDrawer';

export default RecordDetailDrawer;
