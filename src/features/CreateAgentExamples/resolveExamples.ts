/**
 * Which example cards the create-agent modal shows.
 *
 * Extracted as a pure function so the (four-way) decision is testable without rendering the
 * modal: the platform answer arrives asynchronously and getting the "still unknown" case wrong
 * flashes built-in examples at a tenant whose operator replaced them.
 */

/** One rendered card, whatever produced it. */
export interface CreateAgentExampleCard {
  avatar?: string | null;
  backgroundColor?: string | null;
  /** Card subtitle. */
  description: string;
  id: string;
  /** Text written into the chat input when the card is clicked. */
  prompt: string;
  title: string;
}

/** A platform-managed row, narrowed to what a card needs. */
export interface CreateAgentExampleTemplate {
  avatar?: string | null;
  backgroundColor?: string | null;
  description: string;
  id: string;
  systemRole: string;
  title: string;
}

export interface PlatformAgentExamplesState {
  managed: boolean;
  /** False while the platform answer is still unknown (config not hydrated / read in flight). */
  resolved: boolean;
  templates: readonly CreateAgentExampleTemplate[];
}

export type CreateAgentExamplesView =
  /** Render nothing: either the answer is unknown, or the operator enabled no template. */
  | { kind: 'hidden' }
  /** Today's behaviour: shuffled locale examples with a refresh control. */
  | { kind: 'locale' }
  /** Operator-authored cards, in admin order, with no refresh (the order is the product). */
  | { cards: CreateAgentExampleCard[]; kind: 'platform' };

/** Longest subtitle taken from the prompt when a template carries no description. */
export const EXAMPLE_SUBTITLE_MAX = 160;

const truncate = (value: string, max = EXAMPLE_SUBTITLE_MAX): string => {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max).trimEnd()}…`;
};

export const toCreateAgentExampleCard = (
  template: CreateAgentExampleTemplate,
): CreateAgentExampleCard => ({
  avatar: template.avatar ?? null,
  backgroundColor: template.backgroundColor ?? null,
  // The prompt stands in for a missing description, exactly like the locale cards do.
  description: template.description.trim() || truncate(template.systemRole),
  id: template.id,
  prompt: template.systemRole,
  title: template.title,
});

export const resolveCreateAgentExamplesView = ({
  mode,
  platform,
}: {
  mode: 'agent' | 'group';
  platform: PlatformAgentExamplesState;
}): CreateAgentExamplesView => {
  // Group examples are not part of the platform catalog — they stay locale-driven.
  if (mode !== 'agent') return { kind: 'locale' };
  // Unknown yet: showing the built-ins now would flash them at a managed tenant.
  if (!platform.resolved) return { kind: 'hidden' };
  if (!platform.managed) return { kind: 'locale' };
  // Managed with nothing enabled is a deliberate "no examples", not a reason to fall back.
  if (platform.templates.length === 0) return { kind: 'hidden' };

  return { cards: platform.templates.map(toCreateAgentExampleCard), kind: 'platform' };
};
