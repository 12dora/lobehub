'use client';

import { Flexbox, Tag } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import type { AdminAccessContextValue } from '@/enterprise/client/providers/AdminAccessProvider';
import type {
  AdminUsersBanInput,
  AdminUsersUnbanInput,
} from '@/enterprise/client/services/adminUsers';

import { openBanUserModal, openUnbanUserModal } from '../../../users/modals/actions';
import ManageGuard from '../../ManageGuard';
import type { ModerationRecordDetail } from '../../types';
import { Field, Section } from './primitives';

export interface DispositionSectionProps {
  authMethod: AdminAccessContextValue['authMethod'];
  banUser: (input: AdminUsersBanInput) => Promise<unknown>;
  canBanUsers: boolean;
  record: ModerationRecordDetail;
  unbanUser: (input: AdminUsersUnbanInput) => Promise<unknown>;
  userDeleted: boolean;
  userLabel: string;
}

const DispositionSection = memo<DispositionSectionProps>(
  ({ authMethod, banUser, canBanUsers, record, unbanUser, userDeleted, userLabel }) => {
    const { t } = useTranslation('admin');

    return (
      <Section title={t('contentModeration.records.sectionDisposition')}>
        <Field label={t('contentModeration.records.violationCount')}>{record.violationCount}</Field>
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
    );
  },
);

DispositionSection.displayName = 'ModerationRecordDispositionSection';

export default DispositionSection;
