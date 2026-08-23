'use client';

import type { TFunction } from 'i18next';
import { useMemo } from 'react';

import type { KeywordRule } from '@/types/platform/contentModeration';

import type { ConfigValidationMessage } from '../configErrors';
import {
  type DraftIssue,
  type ModerationSettingsDraft,
  validateDraftBase,
  validateKeywordRules,
} from './draft';

/** Validation keys whose message belongs under the classifier sub-form. */
const CLASSIFIER_ISSUE_KEYS = new Set([
  'llmJudgeRequired',
  'moderationsApiRequired',
  'moderationsApiUrl',
  'moderationsApiKeyRequired',
]);

export interface UseModerationValidationParams {
  deferredKeywords?: readonly KeywordRule[];
  draft: ModerationSettingsDraft | null;
  fieldError: ConfigValidationMessage | null;
  /** Endpoint the stored Moderations keys were saved against (server truth, not the draft). */
  persistedBaseUrl?: string;
  t: TFunction<'admin'>;
}

/**
 * The client-side mirror of the server validation, split in two so the expensive half — the
 * keyword rules — is memoized on the deferred array identity instead of on every keystroke.
 */
export const useModerationValidation = ({
  deferredKeywords,
  draft,
  fieldError,
  persistedBaseUrl,
  t,
}: UseModerationValidationParams) => {
  const baseIssues = useMemo(
    () => (draft ? validateDraftBase(draft, { persistedBaseUrl }) : []),
    [draft, persistedBaseUrl],
  );
  // Same deferral as the fingerprint — validating 10,000 rules per keystroke is the other half.
  const keywordIssues = useMemo<DraftIssue[]>(
    () => (deferredKeywords ? validateKeywordRules(deferredKeywords) : []),
    [deferredKeywords],
  );
  const issues = useMemo(() => [...baseIssues, ...keywordIssues], [baseIssues, keywordIssues]);

  /** Local validation that belongs to the classifier section, so it renders next to the fields. */
  const classifierMessage = useMemo(() => {
    if (fieldError?.field?.startsWith('classifier.')) return fieldError;
    const issue = baseIssues.find((item) => CLASSIFIER_ISSUE_KEYS.has(item.key));
    if (!issue) return null;
    return { message: t(`contentModeration.errors.${issue.key}` as never, issue.params) };
  }, [baseIssues, fieldError, t]);

  return { baseIssues, classifierMessage, issues, keywordIssues };
};
