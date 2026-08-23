// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Layout invariants of the card/modal chrome, asserted on the stylesheet source.
 *
 * jsdom and happy-dom do not lay out or compute flexbox, so a rendering test can only prove that
 * the long forms stay in the DOM (`InfraSettingsCard.test.tsx` does). The other half of the
 * contract — that the box they live in can actually be scrolled to reach them — is a CSS fact, and
 * this is where it is pinned so it cannot be undone by an innocent-looking edit.
 */
const source = readFileSync(new URL('./styles.ts', import.meta.url), 'utf8');

const rule = (name: string): string => {
  const start = source.indexOf(`${name}: css\``);
  expect(start, `missing style rule: ${name}`).toBeGreaterThan(-1);
  const from = start + `${name}: css\``.length;
  const end = source.indexOf('`', from);
  return source.slice(from, end);
};

describe('infraSettingsStyles modal chrome', () => {
  it('gives the scroll box a definite block size instead of only capping it', () => {
    const body = rule('modalBody');

    // A capped `overflow: hidden` box whose children are laid out along the INLINE axis leaves the
    // scroller's block size indefinite: the content is clipped and nothing scrolls, so the bottom
    // of the longest form (沙箱) — its last fields and, in a short viewport, the action row —
    // becomes unreachable.
    expect(body).toMatch(/flex-direction:\s*column/);
    expect(body).toMatch(/min-block-size:\s*0/);
    expect(body).toMatch(/max-block-size:\s*70vh/);
    expect(body).toMatch(/overflow:\s*hidden/);
  });

  it('lets the scroller claim the whole of that cap', () => {
    const scroller = rule('modalScroller');

    // `flex: 1` resolves against the column set above; `min-block-size: 0` is what allows it to
    // shrink below its content and become a scroll container rather than growing past the cap.
    expect(scroller).toMatch(/flex:\s*1/);
    expect(scroller).toMatch(/min-block-size:\s*0/);
  });

  it('lets the tallest card measure the row instead of a hard-coded floor', () => {
    // `grid-auto-rows: 1fr` already makes every card as tall as the tallest one. A
    // `min-block-size` on the card on top of that cannot make anything line up that was not
    // lined up already — all it can do is hold every card open at a constant, which is where the
    // blank band between the last reading and the action row came from.
    expect(rule('card')).not.toMatch(/min-block-size:/);
    expect(rule('grid')).toMatch(/grid-auto-rows:\s*1fr/);
    // The action rows still line up across the grid: that is what the slack is spent on.
    expect(rule('footer')).toMatch(/margin-block-start:\s*auto/);
  });

  it('never leaves a clipping box without a size to clip against', () => {
    // Any rule that hides its overflow has to say how tall it is, or its content is simply lost.
    const rules = [...source.matchAll(/(\w+): css`([^`]*)`/g)];
    const clipping = rules.filter(([, , body]) => /overflow:\s*hidden/.test(body ?? ''));
    expect(clipping.length).toBeGreaterThan(0);

    for (const [, name, body] of clipping) {
      expect(
        /block-size:/.test(body ?? '') || /-webkit-line-clamp/.test(body ?? ''),
        `${name} hides its overflow without a definite block size`,
      ).toBe(true);
    }
  });
});
