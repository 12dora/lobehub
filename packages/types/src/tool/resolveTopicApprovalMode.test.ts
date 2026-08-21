import { describe, expect, it } from 'vitest';

import {
  isTopicApprovalMode,
  resolveTopicApprovalMode,
  topicApprovalModeSchema,
} from './intervention';

describe('isTopicApprovalMode', () => {
  it('accepts the three user-selectable modes', () => {
    expect(isTopicApprovalMode('auto-run')).toBe(true);
    expect(isTopicApprovalMode('allow-list')).toBe(true);
    expect(isTopicApprovalMode('manual')).toBe(true);
  });

  it('rejects headless, empty, and unknown values', () => {
    expect(isTopicApprovalMode('headless')).toBe(false);
    expect(isTopicApprovalMode('')).toBe(false);
    expect(isTopicApprovalMode('plan')).toBe(false);
    expect(isTopicApprovalMode(undefined)).toBe(false);
    expect(isTopicApprovalMode(null)).toBe(false);
  });
});

describe('topicApprovalModeSchema', () => {
  it('parses user-selectable modes and rejects headless', () => {
    expect(topicApprovalModeSchema.parse('auto-run')).toBe('auto-run');
    expect(topicApprovalModeSchema.safeParse('headless').success).toBe(false);
  });
});

describe('resolveTopicApprovalMode', () => {
  it('returns lockedValue when the platform policy is locked', () => {
    expect(
      resolveTopicApprovalMode({
        lockedValue: 'manual',
        platformDefault: 'auto-run',
        platformLocked: true,
        topicApprovalMode: 'allow-list',
        userApprovalMode: 'auto-run',
      }),
    ).toBe('manual');
  });

  it('falls back from a missing lockedValue to platformDefault, then manual', () => {
    expect(
      resolveTopicApprovalMode({
        platformDefault: 'auto-run',
        platformLocked: true,
      }),
    ).toBe('auto-run');

    expect(resolveTopicApprovalMode({ platformLocked: true })).toBe('manual');
  });

  it('lets a locked headless value win', () => {
    expect(
      resolveTopicApprovalMode({
        lockedValue: 'headless',
        platformLocked: true,
        topicApprovalMode: 'manual',
      }),
    ).toBe('headless');
  });

  it('uses the topic value over user preference and platform default', () => {
    expect(
      resolveTopicApprovalMode({
        platformDefault: 'auto-run',
        topicApprovalMode: 'allow-list',
        userApprovalMode: 'manual',
      }),
    ).toBe('allow-list');
  });

  it('uses the user preference when the topic has no mode', () => {
    expect(
      resolveTopicApprovalMode({
        platformDefault: 'auto-run',
        userApprovalMode: 'allow-list',
      }),
    ).toBe('allow-list');
  });

  it('preserves a headless user preference when the topic is unset', () => {
    expect(resolveTopicApprovalMode({ userApprovalMode: 'headless' })).toBe('headless');
  });

  it('uses the platform default when topic and user are unset', () => {
    expect(resolveTopicApprovalMode({ platformDefault: 'auto-run' })).toBe('auto-run');
  });

  it('falls back to built-in manual when nothing is set', () => {
    expect(resolveTopicApprovalMode({})).toBe('manual');
    expect(
      resolveTopicApprovalMode({
        lockedValue: 'auto-run',
        platformLocked: false,
        topicApprovalMode: null,
        userApprovalMode: undefined,
      }),
    ).toBe('manual');
  });

  it('ignores invalid topic / user / platform values', () => {
    expect(
      resolveTopicApprovalMode({
        platformDefault: 'nope' as never,
        topicApprovalMode: 'plan' as never,
        userApprovalMode: '' as never,
      }),
    ).toBe('manual');
  });

  it('does not treat a falsey platformLocked as locked', () => {
    expect(
      resolveTopicApprovalMode({
        lockedValue: 'manual',
        topicApprovalMode: 'auto-run',
      }),
    ).toBe('auto-run');
  });
});
