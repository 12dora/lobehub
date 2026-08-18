import { render } from '@testing-library/react';
import { DEFAULT_MODEL_PROVIDER_LIST } from 'model-bank/modelProviders';
import { describe, expect, it } from 'vitest';

import { ProviderItemRender } from './index';

/**
 * `ProviderItemRender` is the group header behind EVERY grouped model picker (chat model
 * switch, agent/form selects, image & video pickers). Users see groups named "xAI",
 * "Grok", "Grok Build", "ChatGPT", "ChatGPT Web" and cannot tell them apart, so the header
 * carries an info affordance with the provider description — but only when there is one, and
 * never at the cost of the dense single-line layout.
 */
const infoHint = (container: HTMLElement) => container.querySelector('svg.lucide-info');

const anthropicDescription = DEFAULT_MODEL_PROVIDER_LIST.find(
  (card) => card.id === 'anthropic',
)?.description;

describe('ProviderItemRender', () => {
  it('hangs the description off an info hint for a builtin provider', () => {
    const { container } = render(<ProviderItemRender name={'Anthropic'} provider={'anthropic'} />);

    expect(container.textContent).toContain('Anthropic');
    expect(infoHint(container)).toBeTruthy();
  });

  it('renders no hint for a provider without a description', () => {
    // A custom provider whose row is not in the store has nothing to describe: an empty
    // tooltip trigger would be a promise the header cannot keep.
    const { container } = render(
      <ProviderItemRender name={'My Proxy'} provider={'my-proxy'} source={'custom'} />,
    );

    expect(container.textContent).toContain('My Proxy');
    expect(infoHint(container)).toBeNull();
  });

  it('reaches the description without a pointer, without printing it in the row', () => {
    // Inlining it visibly would break the 12px single-line group header every picker relies
    // on; leaving it in the tooltip ALONE would put it out of reach of a keyboard or a screen
    // reader. So it is rendered as visually hidden text next to the name — no nested button,
    // because this row is a composite select item and an extra tab stop inside it activates
    // nothing.
    const { container } = render(<ProviderItemRender name={'Anthropic'} provider={'anthropic'} />);

    expect(anthropicDescription).toBeTruthy();

    const carrier = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === anthropicDescription,
    );
    expect(carrier).toBeTruthy();
    // Visually hidden, not display:none — a clipped 1px box stays in the accessibility tree.
    expect(getComputedStyle(carrier!).position).toBe('absolute');
    // The visible label is still the name alone.
    expect(container.querySelector('span[aria-hidden]')).toBeTruthy();
  });
});
