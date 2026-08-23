'use client';

import { Text } from '@lobehub/ui';
import { Button, Input, Select, Switch } from '@lobehub/ui/base-ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  MODERATION_LIMITS,
  type ModerationCategory,
  type ModerationCategoryAction,
} from '@/const/platform/contentModeration';
import type { KeywordRule } from '@/types/platform/contentModeration';

import { categoryLabel, policyActionLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import { isValidKeywordRegex } from '../draft';

/** Row identity for the paged view — never the array index, which shifts under search. */
export interface KeywordRow {
  index: number;
  rule: KeywordRule;
}

const KeywordRowEditor = memo<{
  disabled: boolean;
  onChange: (id: string, patch: Partial<KeywordRule>) => void;
  onRemove: (id: string) => void;
  /** Server-side rejection for this specific rule (catastrophic backtracking / too slow). */
  rejection?: string;
  row: KeywordRow;
}>(({ disabled, onChange, onRemove, rejection, row }) => {
  const { t } = useTranslation('admin');
  const { index, rule } = row;
  const regexInvalid = rule.isRegex && !isValidKeywordRegex(rule.pattern);

  return (
    <div
      data-rejected={rejection ? 'true' : undefined}
      data-testid={`keyword-row-${index}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        ...(rejection ? { borderRadius: 6, boxShadow: '0 0 0 2px var(--lobe-color-error)' } : {}),
      }}
    >
      <div className={styles.formRow}>
        <Text className={styles.hintText} style={{ minWidth: 48 }}>
          #{index + 1}
        </Text>
        <Input
          aria-label={t('contentModeration.settings.keywords.pattern')}
          disabled={disabled}
          maxLength={MODERATION_LIMITS.KEYWORD_MAX_LENGTH}
          placeholder={t('contentModeration.settings.keywords.patternPlaceholder')}
          style={{ flex: 1, minWidth: 220 }}
          value={rule.pattern}
          onChange={(event) => onChange(rule.id, { pattern: event.target.value })}
        />
        <label className={styles.toolbarRow}>
          <Switch
            checked={rule.isRegex}
            disabled={disabled}
            size="small"
            onChange={(checked) => onChange(rule.id, { isRegex: Boolean(checked) })}
          />
          <span className={styles.hintText}>
            {t('contentModeration.settings.keywords.isRegex')}
          </span>
        </label>
        <Select
          disabled={disabled}
          style={{ width: 150 }}
          value={rule.category}
          options={MODERATION_CATEGORIES.map((value) => ({
            label: categoryLabel(t, value),
            value,
          }))}
          onChange={(next) =>
            onChange(rule.id, { category: (next as ModerationCategory) ?? 'other' })
          }
        />
        <Select
          disabled={disabled}
          style={{ width: 140 }}
          value={rule.action}
          options={MODERATION_CATEGORY_ACTIONS.map((value) => ({
            label: policyActionLabel(t, value),
            value,
          }))}
          onChange={(next) =>
            onChange(rule.id, { action: (next as ModerationCategoryAction) ?? 'log' })
          }
        />
        <Input
          aria-label={t('contentModeration.settings.keywords.note')}
          disabled={disabled}
          maxLength={200}
          placeholder={t('contentModeration.settings.keywords.notePlaceholder')}
          style={{ width: 180 }}
          value={rule.note ?? ''}
          onChange={(event) => onChange(rule.id, { note: event.target.value || undefined })}
        />
        <label className={styles.toolbarRow}>
          <Switch
            checked={rule.enabled}
            disabled={disabled}
            size="small"
            onChange={(checked) => onChange(rule.id, { enabled: Boolean(checked) })}
          />
          <span className={styles.hintText}>
            {t('contentModeration.settings.keywords.enabled')}
          </span>
        </label>
        <Button
          danger
          disabled={disabled}
          size="small"
          type="text"
          onClick={() => onRemove(rule.id)}
        >
          {t('contentModeration.settings.keywords.remove')}
        </Button>
      </div>
      {regexInvalid ? (
        <Text data-testid={`keyword-regex-error-${index}`} type="danger">
          {t('contentModeration.errors.keywordRegex', { pattern: rule.pattern, row: index + 1 })}
        </Text>
      ) : null}
      {rejection ? (
        <Text data-testid={`keyword-server-error-${index}`} type="danger">
          {rejection}
        </Text>
      ) : null}
    </div>
  );
});
KeywordRowEditor.displayName = 'ModerationKeywordRowEditor';

export default KeywordRowEditor;
