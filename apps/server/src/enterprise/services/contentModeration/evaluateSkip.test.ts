import { describe, expect, it } from 'vitest';

import { createDefaultContentModerationConfig } from '@/types/platform/contentModeration';

import { maybeSkipEvaluation } from './evaluateSkip';

const input = {
  model: 'gpt-4o',
  provider: 'openai',
  requestKind: 'chat' as const,
  text: 'hello world',
  userId: 'user-1',
};

const enforceConfig = () => {
  const config = createDefaultContentModerationConfig();
  config.mode = 'enforce';
  return config;
};

describe('maybeSkipEvaluation', () => {
  it('returns mode_off when mode is off', () => {
    const config = enforceConfig();
    config.mode = 'off';
    expect(maybeSkipEvaluation(config, input, ['member'])).toEqual({
      reason: 'mode_off',
      skipped: true,
    });
  });

  it('returns exempt when a role is in scope.exemptRoles', () => {
    expect(maybeSkipEvaluation(enforceConfig(), input, ['admin'])).toEqual({
      reason: 'exempt',
      skipped: true,
    });
  });

  it('returns request_kind when requestKind is not configured', () => {
    const config = enforceConfig();
    config.requestKinds = ['image'];
    expect(maybeSkipEvaluation(config, input, ['member'])).toEqual({
      reason: 'request_kind',
      skipped: true,
    });
  });

  it('returns model_scope when include filter omits openai/gpt-4o', () => {
    const config = enforceConfig();
    config.scope.modelFilter = { models: ['openai/gpt-4.1'], type: 'include' };
    expect(maybeSkipEvaluation(config, input, ['member'])).toEqual({
      reason: 'model_scope',
      skipped: true,
    });
  });

  it('returns not_sampled when sampleRate is 0', () => {
    const config = enforceConfig();
    config.scope.sampleRate = 0;
    expect(maybeSkipEvaluation(config, input, ['member'])).toEqual({
      reason: 'not_sampled',
      skipped: true,
    });
  });
});
