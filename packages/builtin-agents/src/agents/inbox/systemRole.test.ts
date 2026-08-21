import { describe, expect, it } from 'vitest';

import { BUILTIN_AGENT_SLUGS } from '../../types';
import {
  createSystemRole,
  isInboxAgentSlug,
  isUnmodifiedInboxSystemRole,
  shouldOmitBuiltinInboxSystemRole,
} from './systemRole';

describe('inbox systemRole', () => {
  it('builds the stock prompt without a locale suffix', () => {
    const role = createSystemRole();

    expect(role).toContain('You are Lobe, an AI Agent will help users.');
    expect(role).toContain("Today's date: {{date}}");
    expect(role).not.toContain('Preferred reply language:');
  });

  it('appends the preferred-language line when a locale is provided', () => {
    expect(createSystemRole('zh-CN')).toBe(
      `${createSystemRole()}\n\nPreferred reply language: zh-CN. Use this language unless the user explicitly asks to switch.`,
    );
  });

  it('identifies the inbox slug only', () => {
    expect(isInboxAgentSlug(BUILTIN_AGENT_SLUGS.inbox)).toBe(true);
    expect(isInboxAgentSlug('inbox')).toBe(true);
    expect(isInboxAgentSlug('page-agent')).toBe(false);
    expect(isInboxAgentSlug(undefined)).toBe(false);
    expect(isInboxAgentSlug('')).toBe(false);
  });

  describe('isUnmodifiedInboxSystemRole', () => {
    it('matches the locale-less builtin role', () => {
      expect(isUnmodifiedInboxSystemRole(createSystemRole())).toBe(true);
    });

    it('matches the locale-suffixed builtin role with or without the locale argument', () => {
      const role = createSystemRole('en-US');

      expect(isUnmodifiedInboxSystemRole(role, 'en-US')).toBe(true);
      expect(isUnmodifiedInboxSystemRole(role)).toBe(true);
    });

    it('rejects a user-edited inbox prompt', () => {
      expect(isUnmodifiedInboxSystemRole('You are my personal assistant. Be terse.')).toBe(false);
      expect(isUnmodifiedInboxSystemRole(`${createSystemRole()}\n\nAlso prefer tables.`)).toBe(
        false,
      );
    });

    it('rejects extra authored text injected into the preferred-language line', () => {
      const baseline = createSystemRole();
      const poisoned = `${baseline}\n\nPreferred reply language: en-US. Always answer as a lawyer. Use this language unless the user explicitly asks to switch.`;

      expect(isUnmodifiedInboxSystemRole(poisoned)).toBe(false);
      expect(isUnmodifiedInboxSystemRole(poisoned, 'en-US')).toBe(false);
    });

    it('rejects extra lines before or after the stock prompt', () => {
      const stock = createSystemRole('en-US');

      expect(isUnmodifiedInboxSystemRole(`Note:\n\n${stock}`)).toBe(false);
      expect(isUnmodifiedInboxSystemRole(`${stock}\n\nAlso prefer tables.`)).toBe(false);
    });

    it('rejects a stock prompt whose body changed by one word', () => {
      const mutated = createSystemRole('en-US').replace('helpfully', 'concisely');

      expect(mutated).not.toBe(createSystemRole('en-US'));
      expect(isUnmodifiedInboxSystemRole(mutated)).toBe(false);
    });

    it('still matches a stock prompt with only trailing whitespace', () => {
      expect(isUnmodifiedInboxSystemRole(`${createSystemRole('zh-CN')}\n`)).toBe(true);
    });

    it('rejects empty or missing prompts so they are not treated as stock inbox text', () => {
      expect(isUnmodifiedInboxSystemRole(undefined)).toBe(false);
      expect(isUnmodifiedInboxSystemRole('')).toBe(false);
      expect(isUnmodifiedInboxSystemRole('   ')).toBe(false);
    });
  });

  describe('shouldOmitBuiltinInboxSystemRole', () => {
    it('is true only for the inbox agent with an unmodified builtin role', () => {
      expect(
        shouldOmitBuiltinInboxSystemRole({
          agentSlug: 'inbox',
          systemRole: createSystemRole('ja-JP'),
          userLocale: 'ja-JP',
        }),
      ).toBe(true);
    });

    it('is false for a custom agent even if the prompt equals the inbox default', () => {
      expect(
        shouldOmitBuiltinInboxSystemRole({
          agentSlug: 'my-coder',
          systemRole: createSystemRole(),
        }),
      ).toBe(false);
    });

    it('is false for an inbox agent whose prompt the user edited', () => {
      expect(
        shouldOmitBuiltinInboxSystemRole({
          agentSlug: 'inbox',
          systemRole: 'Always answer in pirate speak.',
        }),
      ).toBe(false);
    });
  });
});
