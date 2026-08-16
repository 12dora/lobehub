import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import {
  type DecisionServiceDeps,
  type EvaluatedDecision,
  evaluatePrompt,
  resetModerationDedupeForTest,
} from './decisionService';
import { compileKeywordMatcher } from './keywordMatcher';
import { emptyCategoryScores } from './policy';
import type { ModerationSnapshot } from './settingsSnapshot';

const config = createDefaultContentModerationConfig();
config.mode = 'enforce';
config.classifier.kind = 'llm_judge';
config.classifier.llmJudge = { model: 'judge', provider: 'openai' };

const snapshot = (overrides: Partial<typeof config> = {}): ModerationSnapshot => {
  const next = structuredClone({ ...config, ...overrides });
  if (overrides.keywords) next.keywords = overrides.keywords;
  if (overrides.classifier) next.classifier = { ...config.classifier, ...overrides.classifier };
  return {
    config: next,
    digest: 'd',
    exemptRoles: new Set(next.scope.exemptRoles),
    exemptUserIds: new Set(next.scope.exemptUserIds),
    matcher: compileKeywordMatcher(next.keywords),
    modelScope: next.scope.modelFilter,
    revision: 1,
    updatedAt: new Date(),
  };
};

const classifyMock = () =>
  Promise.resolve({
    classify: async () => ({
      latencyMs: 5,
      scores: { ...emptyCategoryScores(), sexual: 0.9 },
    }),
    kind: 'llm_judge' as const,
  });

const baseDeps = (
  snap: ModerationSnapshot,
  extra: Partial<DecisionServiceDeps> = {},
): DecisionServiceDeps => ({
  classify: classifyMock,
  getDecision: async () => null,
  getRoles: async () => ['member'],
  getSnapshot: async () => snap,
  now: () => 1_000,
  ...extra,
});

const input = {
  model: 'gpt-4o',
  provider: 'openai',
  requestKind: 'chat' as const,
  text: 'hello world',
  userId: 'user-1',
};

afterEach(() => {
  resetModerationDedupeForTest();
});

describe('evaluatePrompt', () => {
  it('short-circuits the classifier on a keyword hit', async () => {
    let classified = 0;
    const snap = snapshot({
      keywords: [
        {
          action: 'block',
          category: 'sexual',
          enabled: true,
          id: '11111111-1111-4111-8111-111111111111',
          isRegex: false,
          pattern: 'hello',
        },
      ],
    });
    const decision = (await evaluatePrompt({} as never, input, {
      ...baseDeps(snap),
      classify: async () => {
        classified += 1;
        return classifyMock();
      },
    })) as EvaluatedDecision;
    expect(decision.skipped).toBe(false);
    expect(decision.source).toBe('keyword');
    expect(decision.policyAction).toBe('block');
    expect(classified).toBe(0);
  });

  it('replays a cache hit without calling the classifier', async () => {
    let classified = 0;
    const decision = (await evaluatePrompt({} as never, input, {
      ...baseDeps(snapshot()),
      classify: async () => {
        classified += 1;
        return classifyMock();
      },
      getDecision: async () => ({ categories: { violence: 0.95 }, source: 'llm_judge' }),
    })) as EvaluatedDecision;
    expect(decision.source).toBe('cache');
    expect(decision.policyAction).toBe('log');
    expect(classified).toBe(0);
  });

  it('folds observe mode to allow while keeping policyAction', async () => {
    const snap = snapshot({ mode: 'observe' });
    const decision = (await evaluatePrompt(
      {} as never,
      input,
      baseDeps(snap),
    )) as EvaluatedDecision;
    expect(decision.policyAction).toBe('block');
    expect(decision.effectiveAction).toBe('allow');
  });

  it('maps classifier failure to error or block per onError', async () => {
    const allowSnap = snapshot({ classifier: { ...config.classifier, onError: 'allow' } });
    const allow = (await evaluatePrompt({} as never, input, {
      ...baseDeps(allowSnap),
      classify: async () => {
        throw new Error('boom');
      },
    })) as EvaluatedDecision;
    expect(allow.effectiveAction).toBe('error');
    expect(allow.enforce).toBe(false);
    expect(allow.error).toBe('upstream_error');

    resetModerationDedupeForTest();

    const blockSnap = snapshot({ classifier: { ...config.classifier, onError: 'block' } });
    const blocked = (await evaluatePrompt({} as never, input, {
      ...baseDeps(blockSnap),
      classify: async () => {
        throw new Error('boom');
      },
    })) as EvaluatedDecision;
    expect(blocked.effectiveAction).toBe('error');
    expect(blocked.enforce).toBe(true);
    expect(blocked.error).toBe('upstream_error');
  });

  it('escalates image downgrade to block', async () => {
    const snap = snapshot();
    snap.config.categories.jailbreak = { action: 'downgrade', threshold: 0.1 };
    snap.config.downgrade = { model: 'safe', provider: 'openai' };
    const decision = (await evaluatePrompt(
      {} as never,
      { ...input, requestKind: 'image', text: 'jail' },
      {
        ...baseDeps(snap),
        classify: async () => ({
          classify: async () => ({
            latencyMs: 1,
            scores: { jailbreak: 1 } as never,
          }),
          kind: 'llm_judge',
        }),
      },
    )) as EvaluatedDecision;
    expect(decision.policyAction).toBe('downgrade');
    expect(decision.effectiveAction).toBe('block');
  });

  it('logs when the requested model already is the downgrade target', async () => {
    const snap = snapshot();
    snap.config.categories.jailbreak = { action: 'downgrade', threshold: 0.1 };
    snap.config.downgrade = { model: 'gpt-4o', provider: 'openai' };
    const decision = (await evaluatePrompt({} as never, input, {
      ...baseDeps(snap),
      classify: async () => ({
        classify: async () => ({ latencyMs: 1, scores: { jailbreak: 1 } as never }),
        kind: 'llm_judge',
      }),
    })) as EvaluatedDecision;
    expect(decision.effectiveAction).toBe('log');
  });

  it('reuses a 60s per-user+hash decision without reclassifying', async () => {
    let classified = 0;
    const deps: DecisionServiceDeps = {
      ...baseDeps(snapshot()),
      classify: async () => {
        classified += 1;
        return classifyMock();
      },
    };
    const first = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    const second = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(first.hash).toBe(second.hash);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(second.effectiveAction).toBe(first.effectiveAction);
    expect(classified).toBe(1);
  });

  it('re-folds a cached chat downgrade to block when the reuse is an image request', async () => {
    const snap = snapshot();
    snap.config.categories.jailbreak = { action: 'downgrade', threshold: 0.1 };
    snap.config.downgrade = { model: 'safe', provider: 'openai' };
    const deps = {
      ...baseDeps(snap),
      classify: async () => ({
        classify: async () => ({
          latencyMs: 1,
          scores: { ...emptyCategoryScores(), jailbreak: 1 },
        }),
        kind: 'llm_judge' as const,
      }),
    };
    const chat = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(chat.effectiveAction).toBe('downgrade');
    expect(chat.reused).toBe(false);

    const image = (await evaluatePrompt(
      {} as never,
      { ...input, requestKind: 'image' },
      deps,
    )) as EvaluatedDecision;
    expect(image.reused).toBe(true);
    expect(image.recordId).toBe(chat.recordId);
    expect(image.policyAction).toBe('downgrade');
    expect(image.effectiveAction).toBe('block');
  });

  it('re-runs current policy on reuse so a settings change within 60s applies', async () => {
    const snap = snapshot();
    const deps: DecisionServiceDeps = {
      ...baseDeps(snap),
      getSnapshot: async () => snap,
    };
    const first = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(first.policyAction).toBe('block');

    snap.config.categories.sexual = { action: 'log', threshold: 0.65 };
    const second = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(second.reused).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(second.policyAction).toBe('log');
    expect(second.effectiveAction).toBe('log');
  });

  it('single-flights concurrent identical evaluations onto one classification', async () => {
    let classified = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps: DecisionServiceDeps = {
      ...baseDeps(snapshot()),
      classify: async () => {
        classified += 1;
        await gate;
        return classifyMock();
      },
    };

    const firstPending = evaluatePrompt({} as never, input, deps);
    const secondPending = evaluatePrompt({} as never, input, deps);
    release();
    const [left, right] = (await Promise.all([firstPending, secondPending])) as [
      EvaluatedDecision,
      EvaluatedDecision,
    ];

    expect(classified).toBe(1);
    const first = left.reused ? right : left;
    const second = left.reused ? left : right;
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.recordId).toBe(first.recordId);
    expect(second.hash).toBe(first.hash);
  });

  it('maps classifier failures to a finite code and never persists or logs secrets', async () => {
    const leaked = 'sk-abc leaked prompt: hello world';
    const logs: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      logs.push(args);
    });

    const decision = (await evaluatePrompt({} as never, input, {
      ...baseDeps(snapshot()),
      classify: async () => {
        throw new Error(leaked);
      },
    })) as EvaluatedDecision;

    expect(decision.error).toBe('upstream_error');
    expect(JSON.stringify(decision)).not.toContain('sk-abc');
    expect(JSON.stringify(decision)).not.toContain('hello world');
    expect(JSON.stringify(decision)).not.toContain(leaked);

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain('sk-abc');
    expect(logged).not.toContain('hello world');
    expect(logged).not.toContain(leaked);
    expect(logs.some((entry) => JSON.stringify(entry).includes('upstream_error'))).toBe(true);
    expect(logs.some((entry) => JSON.stringify(entry).includes('"errorClass":"Error"'))).toBe(true);

    spy.mockRestore();
  });

  it('re-classifies after a failed single-flight instead of reusing the error', async () => {
    let classified = 0;
    const deps: DecisionServiceDeps = {
      ...baseDeps(snapshot()),
      classify: async () => {
        classified += 1;
        if (classified === 1) throw new Error('transient');
        return classifyMock();
      },
    };

    const first = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(first.reused).toBe(false);
    expect(first.error).toBe('upstream_error');

    const second = (await evaluatePrompt({} as never, input, deps)) as EvaluatedDecision;
    expect(second.reused).toBe(false);
    expect(second.error).toBeUndefined();
    expect(second.source).toBe('llm_judge');
    expect(classified).toBe(2);
  });
});
