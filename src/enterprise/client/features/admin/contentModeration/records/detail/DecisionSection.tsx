'use client';

import { Text } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  categoryLabel,
  decisionSourceLabel,
  formatLatency,
  formatScore,
  policyActionLabel,
} from '../../format';
import { moderationStyles as styles } from '../../styles';
import type { ModerationRecordDetail } from '../../types';
import ActionTag from '../ActionTag';
import CategoryScoreBars from '../CategoryScoreBars';
import { Field, Section } from './primitives';

export interface DecisionSectionProps {
  record: ModerationRecordDetail;
}

const DecisionSection = memo<DecisionSectionProps>(({ record }) => {
  const { t } = useTranslation('admin');

  return (
    <Section title={t('contentModeration.records.sectionDecision')}>
      <Field label={t('contentModeration.records.columns.action')}>
        <ActionTag effectiveAction={record.effectiveAction} policyAction={record.policyAction} />
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
      <CategoryScoreBars scores={record.categoryScores} thresholds={record.thresholdSnapshot} />
    </Section>
  );
});

DecisionSection.displayName = 'ModerationRecordDecisionSection';

export default DecisionSection;
