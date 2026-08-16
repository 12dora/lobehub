import { PLATFORM_ERROR_CODES } from '@/const/platform/errorCodes';
import type { KeywordRule, RegexSafetyResult } from '@/types/platform/contentModeration';
import { assessRegexSafety } from '@/types/platform/contentModeration';

import { throwEnterpriseError } from '../../../guards/enterpriseErrors';
import { probeRegexPattern } from '../../../services/contentModeration/regexWorker';

export const MAX_REGEX_PROBES_PER_SAVE = 100;
export const REGEX_PROBE_AGGREGATE_DEADLINE_MS = 5000;

const rejectKeywordRegex = (index: number, reason: 'regex_unsafe' | 'regex_slow'): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { field: 'keywords', index, reason },
  });

const rejectTooManyRegexChanges = (): never =>
  throwEnterpriseError({
    code: PLATFORM_ERROR_CODES.PLATFORM_CONFIG_VALIDATION_FAILED,
    details: { field: 'keywords', reason: 'too_many_regex_changes' },
  });

/**
 * Static ReDoS check on every enabled regex, then an interruptible worker
 * probe only for patterns that were not previously enabled as regex.
 */
export const assertKeywordRegexesSafe = async (params: {
  next: readonly KeywordRule[];
  now?: () => number;
  previous?: readonly KeywordRule[] | null;
  probe?: (pattern: string, options?: { timeoutMs?: number }) => Promise<RegexSafetyResult>;
}): Promise<void> => {
  const previousEnabled = new Set(
    (params.previous ?? [])
      .filter((rule) => rule.enabled && rule.isRegex)
      .map((rule) => rule.pattern),
  );

  const enabledRegex = params.next
    .map((rule, index) => ({ index, rule }))
    .filter(({ rule }) => rule.enabled && rule.isRegex);

  const changed = enabledRegex.filter(({ rule }) => !previousEnabled.has(rule.pattern));
  if (changed.length > MAX_REGEX_PROBES_PER_SAVE) rejectTooManyRegexChanges();

  for (const { index, rule } of enabledRegex) {
    const staticResult = assessRegexSafety(rule.pattern);
    if (!staticResult.ok) rejectKeywordRegex(index, 'regex_unsafe');
  }

  const probe = params.probe ?? probeRegexPattern;
  const now = params.now ?? Date.now;
  const started = now();
  for (const { index, rule } of changed) {
    if (now() - started > REGEX_PROBE_AGGREGATE_DEADLINE_MS) rejectTooManyRegexChanges();
    const result = await probe(rule.pattern, { timeoutMs: 200 });
    if (result.ok) continue;
    rejectKeywordRegex(index, result.reason === 'invalid' ? 'regex_unsafe' : 'regex_slow');
  }
};
