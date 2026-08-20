import { describe, expect, it } from 'vitest';

import {
  type CreateAgentExampleTemplate,
  EXAMPLE_SUBTITLE_MAX,
  resolveCreateAgentExamplesView,
  toCreateAgentExampleCard,
} from './resolveExamples';

const template = (
  overrides: Partial<CreateAgentExampleTemplate> = {},
): CreateAgentExampleTemplate => ({
  avatar: '📊',
  backgroundColor: '#123456',
  description: 'Turns raw numbers into a weekly brief',
  id: 'tpl-1',
  systemRole: 'You are a data analyst.',
  title: 'Data analyst',
  ...overrides,
});

describe('resolveCreateAgentExamplesView', () => {
  it('keeps the locale pool for groups even when an agent catalog is managed', () => {
    // The two halves share one modal; the agent catalog must never take over the group half.
    expect(
      resolveCreateAgentExamplesView({
        mode: 'group',
        platform: { managed: true, resolved: true, templates: [template()] },
      }),
    ).toEqual({ kind: 'locale' });
  });

  it('renders nothing while the platform answer is still unknown', () => {
    // Falling back early would flash the built-ins at a tenant whose operator replaced them.
    expect(
      resolveCreateAgentExamplesView({
        mode: 'agent',
        platform: { managed: false, resolved: false, templates: [] },
      }),
    ).toEqual({ kind: 'hidden' });
  });

  it('keeps the locale pool when no operator manages the catalog', () => {
    expect(
      resolveCreateAgentExamplesView({
        mode: 'agent',
        platform: { managed: false, resolved: true, templates: [] },
      }),
    ).toEqual({ kind: 'locale' });
  });

  it('hides the section when the catalog is managed but nothing is enabled', () => {
    // "Managed with none enabled" is a deliberate empty state, not a reason to fall back.
    expect(
      resolveCreateAgentExamplesView({
        mode: 'agent',
        platform: { managed: true, resolved: true, templates: [] },
      }),
    ).toEqual({ kind: 'hidden' });
  });

  it('renders every managed template, in the order the operator arranged', () => {
    const view = resolveCreateAgentExamplesView({
      mode: 'agent',
      platform: {
        managed: true,
        resolved: true,
        templates: [template({ id: 'b', title: 'Second' }), template({ id: 'a', title: 'First' })],
      },
    });

    expect(view.kind).toBe('platform');
    expect(view.kind === 'platform' ? view.cards.map((card) => card.title) : []).toEqual([
      'Second',
      'First',
    ]);
  });
});

describe('toCreateAgentExampleCard', () => {
  it('prefills the input with the prompt, not the subtitle the card shows', () => {
    const card = toCreateAgentExampleCard(template());

    expect(card.prompt).toBe('You are a data analyst.');
    expect(card.description).toBe('Turns raw numbers into a weekly brief');
  });

  it('falls back to the prompt when the operator wrote no description', () => {
    expect(toCreateAgentExampleCard(template({ description: '   ' })).description).toBe(
      'You are a data analyst.',
    );
  });

  it('truncates a long prompt used as a subtitle instead of pasting the whole instruction', () => {
    const long = `${'word '.repeat(200)}end`;
    const card = toCreateAgentExampleCard(template({ description: '', systemRole: long }));

    expect(card.description.length).toBeLessThanOrEqual(EXAMPLE_SUBTITLE_MAX + 1);
    expect(card.description.endsWith('…')).toBe(true);
    // The click payload keeps the full prompt — only the card copy is shortened.
    expect(card.prompt).toBe(long);
  });
});
