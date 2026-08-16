'use client';

import { Alert, Tag, Text } from '@lobehub/ui';
import { Button, TextArea } from '@lobehub/ui/base-ui';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MODERATION_LIMITS } from '@/const/platform/contentModeration';
import { useAdminAccess } from '@/enterprise/client/providers/AdminAccessProvider';
import type { ContentModerationTestClassifierOutput } from '@/types/platform/contentModeration';

import { runAdminMutation } from '../../primitives/runAdminMutation';
import { resolveConfigValidationMessage } from '../configErrors';
import { decisionSourceLabel, formatLatency, policyActionLabel } from '../format';
import ManageGuard from '../ManageGuard';
import CategoryScoreBars from '../records/CategoryScoreBars';
import { adminContentModerationService } from '../service';
import { moderationStyles as styles } from '../styles';
import {
  fingerprintDraft,
  type ModerationSettingsDraft,
  toUpdateConfig,
  validateDraftBase,
} from './draft';

export interface TestPanelProps {
  canManage: boolean;
  /** Current (possibly unsaved) form state — the test must reflect what the admin sees. */
  draft: ModerationSettingsDraft;
  /** Deferred keyword validation is still catching up; a dry run would judge stale rules. */
  keywordsPending?: boolean;
  persistedBaseUrl?: string;
}

/** The classifier cannot answer at all while one of these is unresolved. */
const BLOCKING_ISSUE_KEYS = new Set([
  'llmJudgeRequired',
  'moderationsApiRequired',
  'moderationsApiUrl',
  'moderationsApiKeyRequired',
]);

interface TestRun {
  /** Fingerprint of the settings the run was made against. */
  configFingerprint: string;
  output: ContentModerationTestClassifierOutput;
  text: string;
}

/**
 * 试跑: run the current form against a sample text without saving it (design §6.3.3).
 * Answers "what would this configuration do", which is the only safe way to tune thresholds.
 *
 * A result is pinned to the exact text + configuration it came from. Editing either marks it
 * stale rather than leaving a stale 拟处置 on screen that looks like the current answer.
 */
const TestPanel = memo<TestPanelProps>(
  ({ canManage, draft, keywordsPending, persistedBaseUrl }) => {
    const { t } = useTranslation('admin');
    const { authMethod } = useAdminAccess();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [run, setRun] = useState<TestRun | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // Only fingerprinted while a result is on screen — nothing to compare against otherwise.
    const currentFingerprint = useMemo(() => (run ? fingerprintDraft(draft) : ''), [draft, run]);
    const stale =
      Boolean(run) && (run!.text !== text || run!.configFingerprint !== currentFingerprint);

    /**
     * A dry run against an unusable classifier only produces a confusing failure, so it is blocked
     * with the same message 保存 would give — notably the "no key survives the endpoint change" case.
     */
    const blockingIssue = useMemo(() => {
      const issues = validateDraftBase(draft, { persistedBaseUrl });
      return issues.find((issue) => BLOCKING_ISSUE_KEYS.has(issue.key)) ?? null;
    }, [draft, persistedBaseUrl]);
    const blockedMessage = blockingIssue
      ? t(`contentModeration.errors.${blockingIssue.key}` as never, blockingIssue.params)
      : keywordsPending
        ? t('contentModeration.settings.keywordsValidating')
        : null;

    const execute = async () => {
      const trimmed = text.trim();
      if (!canManage || busy || !trimmed || blockingIssue || keywordsPending) return;
      setBusy(true);
      setErrorMessage(null);
      try {
        await runAdminMutation({
          authMethod,
          run: async () => {
            const output = await adminContentModerationService.testClassifier({
              config: toUpdateConfig(draft, { persistedBaseUrl }),
              text: trimmed.slice(0, MODERATION_LIMITS.CLASSIFIER_INPUT_MAX_CHARS),
            });
            setRun({ configFingerprint: fingerprintDraft(draft), output, text });
          },
          onError: (cause) => {
            const mapped = resolveConfigValidationMessage(
              cause,
              t,
              'contentModeration.toast.testFailed',
            );
            setErrorMessage(mapped?.message ?? t('contentModeration.toast.testFailed'));
            setRun(null);
          },
        });
      } finally {
        setBusy(false);
      }
    };

    const result = run?.output;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TextArea
          disabled={!canManage}
          maxLength={MODERATION_LIMITS.CLASSIFIER_INPUT_MAX_CHARS}
          placeholder={t('contentModeration.settings.classifier.testPlaceholder')}
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className={styles.toolbarRow}>
          <ManageGuard allowed={canManage}>
            <Button
              loading={busy}
              size="small"
              type="primary"
              disabled={
                !canManage || !text.trim() || Boolean(blockingIssue) || Boolean(keywordsPending)
              }
              onClick={() => void execute()}
            >
              {t('contentModeration.settings.classifier.test')}
            </Button>
          </ManageGuard>
          <span className={styles.hintText}>
            {t('contentModeration.settings.classifier.testHint')}
          </span>
        </div>

        {blockedMessage ? (
          <Alert showIcon data-testid="test-blocked" message={blockedMessage} type="warning" />
        ) : null}

        {errorMessage ? (
          <Alert showIcon data-testid="test-error" message={errorMessage} type="error" />
        ) : null}

        {result ? (
          <div
            data-stale={String(stale)}
            data-testid="moderation-test-result"
            style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: stale ? 0.55 : 1 }}
          >
            {stale ? (
              <Text data-testid="test-result-stale" type="secondary">
                {t('contentModeration.settings.classifier.testStale')}
              </Text>
            ) : null}
            {result.error ? (
              <Alert
                showIcon
                type="warning"
                message={t('contentModeration.settings.classifier.testError', {
                  error: result.error,
                })}
              />
            ) : null}
            <div className={styles.formRow}>
              <Tag size="small">{decisionSourceLabel(t, result.source)}</Tag>
              <Tag color={result.policyAction === 'ignore' ? undefined : 'warning'} size="small">
                {t('contentModeration.settings.classifier.wouldBe', {
                  action: policyActionLabel(t, result.policyAction),
                })}
              </Tag>
              <Text className={styles.hintText}>{formatLatency(result.latencyMs)}</Text>
            </div>
            {result.matchedRule ? (
              <Text className={styles.hintText}>
                {t('contentModeration.settings.classifier.matchedRule', {
                  pattern: result.matchedRule.pattern,
                })}
              </Text>
            ) : null}
            <CategoryScoreBars scores={result.scores} thresholds={draft.config.categories} />
          </div>
        ) : null}
      </div>
    );
  },
);

TestPanel.displayName = 'ModerationTestPanel';

export default TestPanel;
