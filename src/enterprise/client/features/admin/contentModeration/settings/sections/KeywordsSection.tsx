'use client';

import { Text } from '@lobehub/ui';
import { Button, Input, Select, Switch, TextArea, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_ACTIONS,
  MODERATION_LIMITS,
  type ModerationCategory,
  type ModerationCategoryAction,
} from '@/const/platform/contentModeration';
import type { KeywordRule } from '@/types/platform/contentModeration';

import { DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE_OPTIONS } from '../../../primitives/dataTableChange';
import { categoryLabel, policyActionLabel } from '../../format';
import { moderationStyles as styles } from '../../styles';
import {
  isValidKeywordRegex,
  type ModerationConfigView,
  newKeywordRuleId,
  parseKeywordImport,
} from '../draft';
import SettingsSection from '../SettingsSection';

export interface KeywordsSectionProps {
  config: ModerationConfigView;
  disabled: boolean;
  /** Server rejection scoped to one rule (regex unsafe / too slow), if any. */
  fieldError?: { message: string; ruleIndex?: number } | null;
  /** Pending batch-import text, owned by the tab so the leave guard can see it. */
  importText: string;
  onImportTextChange: (text: string) => void;
  onPatch: (patch: Partial<ModerationConfigView>) => void;
}

/** Shared admin page-size ladder, numeric for the local slice math. */
const PAGE_SIZE_OPTIONS = DEFAULT_PAGE_SIZE_OPTIONS.map(Number);

/** Row identity for the paged view — never the array index, which shifts under search. */
interface KeywordRow {
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

/**
 * 关键词规则 (design §6.3.5). The list is allowed to hold 10,000 rules, so only one page of rows
 * is ever mounted and edits address a rule by id — rendering every rule (each one a handful of
 * controls) is what makes a legitimate configuration unusable.
 *
 * Regex rules are validated inline against the same `iu` flags the server compiles with, so a
 * bad pattern is caught on the row instead of failing the whole save.
 */
const KeywordsSection = memo<KeywordsSectionProps>(
  ({ config, disabled, fieldError, importText, onImportTextChange, onPatch }) => {
    const { t } = useTranslation('admin');
    const [importOpen, setImportOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
    // Typing in the filter must not block on re-filtering 10k rules.
    const deferredSearch = useDeferredValue(search);

    const rejectedIndex = fieldError?.ruleIndex;

    const rules = config.keywords;

    const rows = useMemo<KeywordRow[]>(() => {
      const query = deferredSearch.trim().toLowerCase();
      const all = rules.map((rule, index) => ({ index, rule }));
      if (!query) return all;
      return all.filter(
        ({ rule }) =>
          rule.pattern.toLowerCase().includes(query) ||
          (rule.note ?? '').toLowerCase().includes(query),
      );
    }, [deferredSearch, rules]);

    // A row-scoped server rejection has to be reachable: clear the filter and page to the rule.
    useEffect(() => {
      if (rejectedIndex === undefined) return;
      setSearch('');
      setPage(Math.floor(rejectedIndex / pageSize) + 1);
    }, [pageSize, rejectedIndex]);

    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const currentPage = Math.min(page, pageCount);
    const pageRows = useMemo(
      () => rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
      [currentPage, pageSize, rows],
    );

    const updateRule = useCallback(
      (id: string, patch: Partial<KeywordRule>) => {
        // One shallow map, one new object — no structural clone of the whole rule set.
        onPatch({
          keywords: config.keywords.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
        });
      },
      [config.keywords, onPatch],
    );

    const removeRule = useCallback(
      (id: string) => {
        onPatch({ keywords: config.keywords.filter((rule) => rule.id !== id) });
      },
      [config.keywords, onPatch],
    );

    const preview = useMemo(
      () => (importOpen ? parseKeywordImport(importText, rules) : null),
      [importOpen, importText, rules],
    );

    const addRule = () => {
      if (rules.length >= MODERATION_LIMITS.KEYWORD_MAX_RULES) {
        toast.error(
          t('contentModeration.errors.keywordCount', {
            max: MODERATION_LIMITS.KEYWORD_MAX_RULES,
          }),
        );
        return;
      }
      onPatch({
        keywords: [
          ...rules,
          {
            action: 'log' as ModerationCategoryAction,
            category: 'other' as ModerationCategory,
            enabled: true,
            id: newKeywordRuleId(),
            isRegex: false,
            pattern: '',
          },
        ],
      });
      // A new empty rule is appended, so jump to where it actually is.
      setSearch('');
      setPage(Math.ceil((rules.length + 1) / pageSize));
    };

    const applyImport = () => {
      if (!preview) return;
      if (preview.rules.length === 0) {
        toast.error(
          preview.skippedByCapacity > 0
            ? t('contentModeration.settings.keywords.importFull', {
                max: MODERATION_LIMITS.KEYWORD_MAX_RULES,
              })
            : t('contentModeration.settings.keywords.importNothing'),
        );
        return;
      }
      onPatch({
        keywords: [...rules, ...preview.rules.map((rule) => ({ ...rule, id: newKeywordRuleId() }))],
      });
      // Report what was actually inserted, and separately what the ceiling refused.
      toast.success(
        preview.skippedByCapacity > 0
          ? t('contentModeration.settings.keywords.importedPartial', {
              count: preview.rules.length,
              skipped: preview.skippedByCapacity,
            })
          : t('contentModeration.settings.keywords.imported', { count: preview.rules.length }),
      );
      onImportTextChange('');
      setImportOpen(false);
    };

    return (
      <SettingsSection
        description={t('contentModeration.settings.keywords.desc')}
        title={t('contentModeration.settings.keywords.title')}
        actions={
          <div className={styles.toolbarRow}>
            <Text className={styles.hintText}>
              {t('contentModeration.settings.keywords.count', {
                max: MODERATION_LIMITS.KEYWORD_MAX_RULES,
                total: rules.length,
              })}
            </Text>
            <Button disabled={disabled} size="small" onClick={addRule}>
              {t('contentModeration.settings.keywords.add')}
            </Button>
            <Button disabled={disabled} size="small" onClick={() => setImportOpen((open) => !open)}>
              {t('contentModeration.settings.keywords.import')}
            </Button>
          </div>
        }
      >
        {fieldError && fieldError.ruleIndex === undefined ? (
          <Text data-testid="keyword-section-error" type="danger">
            {fieldError.message}
          </Text>
        ) : null}

        {importOpen ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Text className={styles.hintText}>
              {t('contentModeration.settings.keywords.importHint')}
            </Text>
            <TextArea
              aria-label={t('contentModeration.settings.keywords.import')}
              disabled={disabled}
              rows={5}
              value={importText}
              onChange={(event) => onImportTextChange(event.target.value)}
            />
            <div className={styles.toolbarRow}>
              <Text className={styles.hintText} data-testid="keyword-import-preview">
                {t('contentModeration.settings.keywords.importPreview', {
                  capacity: preview?.skippedByCapacity ?? 0,
                  duplicates: preview?.skippedDuplicates ?? 0,
                  invalid: preview?.invalidLines.length ?? 0,
                  valid: preview?.rules.length ?? 0,
                })}
              </Text>
              <Button disabled={disabled} size="small" type="primary" onClick={applyImport}>
                {t('contentModeration.settings.keywords.importApply')}
              </Button>
              <Button
                size="small"
                type="text"
                onClick={() => {
                  setImportOpen(false);
                  onImportTextChange('');
                }}
              >
                {t('contentModeration.settings.keywords.importCancel')}
              </Button>
            </div>
          </div>
        ) : null}

        {rules.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>
              {t('contentModeration.settings.keywords.emptyTitle')}
            </p>
            <p className={styles.emptyDesc}>{t('contentModeration.settings.keywords.emptyDesc')}</p>
          </div>
        ) : (
          <>
            <div className={styles.toolbarRow}>
              <Input
                aria-label={t('contentModeration.settings.keywords.search')}
                placeholder={t('contentModeration.settings.keywords.searchPlaceholder')}
                style={{ width: 260 }}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
              <Text className={styles.hintText} data-testid="keyword-page-info">
                {t('contentModeration.settings.keywords.pageInfo', {
                  matched: rows.length,
                  page: currentPage,
                  pages: pageCount,
                })}
              </Text>
              <Select
                aria-label={t('contentModeration.settings.keywords.pageSize')}
                style={{ width: 120 }}
                value={String(pageSize)}
                options={PAGE_SIZE_OPTIONS.map((size) => ({
                  label: t('contentModeration.settings.keywords.pageSizeOption', { size }),
                  value: String(size),
                }))}
                onChange={(next) => {
                  setPageSize(Number(next ?? DEFAULT_PAGE_SIZE));
                  setPage(1);
                }}
              />
              <Button
                disabled={currentPage <= 1}
                size="small"
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t('contentModeration.settings.keywords.prevPage')}
              </Button>
              <Button
                disabled={currentPage >= pageCount}
                size="small"
                onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
              >
                {t('contentModeration.settings.keywords.nextPage')}
              </Button>
            </div>

            {rows.length === 0 ? (
              <Text className={styles.hintText} data-testid="keyword-search-empty">
                {t('contentModeration.settings.keywords.searchEmpty')}
              </Text>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pageRows.map((row) => (
                  <KeywordRowEditor
                    disabled={disabled}
                    key={row.rule.id}
                    rejection={row.index === rejectedIndex ? fieldError?.message : undefined}
                    row={row}
                    onChange={updateRule}
                    onRemove={removeRule}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </SettingsSection>
    );
  },
);

KeywordsSection.displayName = 'ModerationKeywordsSection';

export default KeywordsSection;
