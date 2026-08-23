'use client';

import { Text } from '@lobehub/ui';
import { Button, toast } from '@lobehub/ui/base-ui';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  MODERATION_LIMITS,
  type ModerationCategory,
  type ModerationCategoryAction,
} from '@/const/platform/contentModeration';
import type { KeywordRule } from '@/types/platform/contentModeration';

import { DEFAULT_PAGE_SIZE } from '../../../primitives/dataTableChange';
import { moderationStyles as styles } from '../../styles';
import { type ModerationConfigView, newKeywordRuleId, parseKeywordImport } from '../draft';
import SettingsSection from '../SettingsSection';
import KeywordImportPanel from './KeywordImportPanel';
import KeywordListToolbar from './KeywordListToolbar';
import KeywordRowEditor, { type KeywordRow } from './KeywordRowEditor';

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
          <KeywordImportPanel
            disabled={disabled}
            importText={importText}
            preview={preview}
            onApply={applyImport}
            onImportTextChange={onImportTextChange}
            onCancel={() => {
              setImportOpen(false);
              onImportTextChange('');
            }}
          />
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
            <KeywordListToolbar
              currentPage={currentPage}
              matched={rows.length}
              pageCount={pageCount}
              pageSize={pageSize}
              search={search}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              onSearchChange={(value) => {
                setSearch(value);
                setPage(1);
              }}
            />

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
