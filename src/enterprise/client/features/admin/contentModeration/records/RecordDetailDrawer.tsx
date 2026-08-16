'use client';

import { Flexbox, Skeleton, Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { Drawer } from 'antd';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';

import { openDangerConfirm } from '../../primitives/DangerConfirm';
import { runAdminMutation } from '../../primitives/runAdminMutation';
import { useAdminUserMutations } from '../../users/hooks/useAdminUsers';
import { displayModerationUser } from '../format';
import { invalidateModerationRecords, useModerationRecord } from '../hooks';
import ManageGuard from '../ManageGuard';
import { adminContentModerationService } from '../service';
import type { ModerationRecordDetail } from '../types';
import BasicSection from './detail/BasicSection';
import ContentSection from './detail/ContentSection';
import DecisionSection from './detail/DecisionSection';
import DispositionSection from './detail/DispositionSection';

export interface RecordDetailDrawerProps {
  canBanUsers: boolean;
  canManage: boolean;
  onClose: () => void;
  open: boolean;
  recordId: string | null;
}

/**
 * Record detail (design §6.2). Four questions in order: what was the request, why was it
 * judged that way, what was the text, and what was done about the user.
 */
const RecordDetailDrawer = memo<RecordDetailDrawerProps>(
  ({ canBanUsers, canManage, onClose, open, recordId }) => {
    const { t } = useTranslation('admin');
    const { authMethod } = useAdminAccess();
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
            <BasicSection record={record} userDeleted={userDeleted} userLabel={userLabel} />
            <DecisionSection record={record} />
            <ContentSection
              canManage={canManage}
              fullPrompt={fullPrompt}
              record={record}
              revealing={revealing}
              onReveal={handleReveal}
            />
            <DispositionSection
              authMethod={authMethod}
              banUser={banUser}
              canBanUsers={canBanUsers}
              record={record}
              unbanUser={unbanUser}
              userDeleted={userDeleted}
              userLabel={userLabel}
            />
          </>
        ) : null}
      </Drawer>
    );
  },
);

RecordDetailDrawer.displayName = 'ModerationRecordDetailDrawer';

export default RecordDetailDrawer;
