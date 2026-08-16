'use client';

import { Button } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { formatAdminDateTime } from '../../../users/utils';
import { formatModelPair, requestKindLabel } from '../../format';
import type { ModerationRecordDetail } from '../../types';
import { Field, Section } from './primitives';

export interface BasicSectionProps {
  record: ModerationRecordDetail;
  userDeleted: boolean;
  userLabel: string;
}

const BasicSection = memo<BasicSectionProps>(({ record, userDeleted, userLabel }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  return (
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
  );
});

BasicSection.displayName = 'ModerationRecordBasicSection';

export default BasicSection;
