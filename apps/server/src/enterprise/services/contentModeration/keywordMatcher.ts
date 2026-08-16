import { createHash } from 'node:crypto';

import { MODERATION_ACTION_SEVERITY } from '@/const/platform/contentModeration';
import type { ContentModerationConfig, KeywordRule } from '@/types/platform/contentModeration';
import { assessRegexSafety } from '@/types/platform/contentModeration';

import { KEYWORD_REGEX_CHUNK_SIZE } from './constants';
import { matchRegexRules } from './regexWorker';

export interface KeywordMatch {
  rule: KeywordRule;
}

export interface CompiledKeywordMatcher {
  digest: string;
  matchAsync: (
    text: string,
    categories?: ContentModerationConfig['categories'],
  ) => Promise<KeywordMatch | null>;
  matchLiterals: (
    text: string,
    categories?: ContentModerationConfig['categories'],
  ) => KeywordMatch | null;
}

const REGEX_FUSE_MS = 60_000;

const fusedDigests = new Map<string, number>();

export const resetKeywordMatcherFuseForTest = () => {
  fusedDigests.clear();
};

const escapeRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
};

const compileSafe = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern, 'iu');
  } catch {
    return null;
  }
};

const effectiveSeverity = (
  rule: KeywordRule,
  categories?: ContentModerationConfig['categories'],
): number => {
  if (!categories) return MODERATION_ACTION_SEVERITY[rule.action];
  const categoryAction = categories[rule.category].action;
  const effective =
    MODERATION_ACTION_SEVERITY[rule.action] >= MODERATION_ACTION_SEVERITY[categoryAction]
      ? rule.action
      : categoryAction;
  return MODERATION_ACTION_SEVERITY[effective];
};

const pickWinner = (
  hits: readonly KeywordRule[],
  categories?: ContentModerationConfig['categories'],
): KeywordRule | null => {
  let winner: KeywordRule | null = null;
  for (const rule of hits) {
    if (!winner) {
      winner = rule;
      continue;
    }
    const next = effectiveSeverity(rule, categories);
    const current = effectiveSeverity(winner, categories);
    // Strictest effective action wins; on a tie the longer (more specific) pattern wins,
    // and only then rule order.
    if (next > current || (next === current && rule.pattern.length > winner.pattern.length)) {
      winner = rule;
    }
  }
  return winner;
};

export const digestKeywordRules = (rules: readonly KeywordRule[]): string =>
  createHash('sha256').update(JSON.stringify(rules)).digest('hex');

/**
 * Compile enabled keyword rules.
 *
 * Literal (non-regex) patterns are escaped and OR-joined in chunks of 500 to
 * avoid one gigantic regex. Regex rules are matched in a worker thread so a
 * catastrophic pattern cannot stall the request event loop.
 *
 * Every enabled rule is evaluated; the match with the **strictest effective
 * action** (`max(rule.action, categories[rule.category].action)`) wins. Ties
 * keep the earlier rule, then the longer pattern.
 */
export const compileKeywordMatcher = (rules: readonly KeywordRule[]): CompiledKeywordMatcher => {
  const digest = digestKeywordRules(rules);
  const enabled = rules.filter((rule) => rule.enabled && rule.pattern.length > 0);

  const literal = enabled.filter((rule) => !rule.isRegex);
  const regexRules = enabled.filter((rule) => rule.isRegex && assessRegexSafety(rule.pattern).ok);

  const compiledLiteral = literal.flatMap((rule) => {
    const compiled = compileSafe(escapeRegExp(rule.pattern));
    return compiled ? [{ compiled, rule }] : [];
  });
  const literalChunks = chunk(compiledLiteral, KEYWORD_REGEX_CHUNK_SIZE).flatMap((group) => {
    const compiled = compileSafe(group.map((item) => item.compiled.source).join('|'));
    return compiled ? [{ compiled, rules: group }] : [];
  });

  const collectLiteralHits = (text: string): KeywordRule[] => {
    if (!text || literalChunks.length === 0) return [];
    const hits: KeywordRule[] = [];
    for (const chunked of literalChunks) {
      if (!chunked.compiled.test(text)) continue;
      for (const item of chunked.rules) {
        if (item.compiled.test(text)) hits.push(item.rule);
      }
    }
    return hits;
  };

  const matchLiterals = (
    text: string,
    categories?: ContentModerationConfig['categories'],
  ): KeywordMatch | null => {
    const winner = pickWinner(collectLiteralHits(text), categories);
    return winner ? { rule: winner } : null;
  };

  const matchAsync = async (
    text: string,
    categories?: ContentModerationConfig['categories'],
  ): Promise<KeywordMatch | null> => {
    if (!text || enabled.length === 0) return null;
    const literalHits = collectLiteralHits(text);

    const fusedUntil = fusedDigests.get(digest) ?? 0;
    const regexFused = fusedUntil > Date.now();
    let regexHits: KeywordRule[] = [];

    if (!regexFused && regexRules.length > 0) {
      const result = await matchRegexRules({
        digest,
        rules: regexRules.map((rule) => ({ id: rule.id, pattern: rule.pattern })),
        text,
      });
      if ('timedOut' in result && result.timedOut) {
        fusedDigests.set(digest, Date.now() + REGEX_FUSE_MS);
        console.error('[content-moderation] regex layer fused after worker timeout', {
          code: 'regex_fused',
        });
      } else if ('matchedRuleIds' in result) {
        const byId = new Map(regexRules.map((rule) => [rule.id, rule]));
        regexHits = result.matchedRuleIds.flatMap((id) => {
          const rule = byId.get(id);
          return rule ? [rule] : [];
        });
      }
    }

    const winner = pickWinner([...literalHits, ...regexHits], categories);
    return winner ? { rule: winner } : null;
  };

  return { digest, matchAsync, matchLiterals };
};
