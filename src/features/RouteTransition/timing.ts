/**
 * One shared clock for every surface that reacts to a top-level section change:
 * the left nav (`NavPanelSection`), the right pane (`RouteTransition`) and the
 * persistent home overlay (`src/routes/(main)/home/_layout/style.ts`).
 *
 * They must stay locked to the same duration/easing — the previous 150ms nav
 * fade + 180ms overlay/outlet fade read as three separate blinks instead of one
 * level change.
 */

/** Shared duration in milliseconds — for CSS declarations and `setTimeout`. */
export const SECTION_TRANSITION_MS = 280;

/** Same duration in seconds — for `motion`'s `transition.duration`. */
export const SECTION_TRANSITION_S = 0.28;

/** iOS-like deceleration. Exported in both shapes so the value cannot drift. */
export const SECTION_TRANSITION_EASE: [number, number, number, number] = [0.32, 0.72, 0, 1];

export const SECTION_TRANSITION_EASE_CSS = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * Left nav travel: ~13% of the panel's 240px min width. Material-scale, not the
 * full-panel iOS push — the sidebar is narrow and a longer throw reads as a jump.
 */
export const NAV_SECTION_TRAVEL_PX = 32;

/**
 * Right pane reveal depth, as a percentage of the pane width. The main outlet is
 * revealed with `clip-path: inset(...)` rather than a translate: a transform on
 * that wrapper would make it the containing block for every `position: fixed`
 * descendant (settings save bar, upload dock, PDF fullscreen nav) for the whole
 * transition. `clip-path` creates no containing block.
 */
export const MAIN_REVEAL_INSET_PERCENT = 6;

/** Fully uncovered box — the `animate` target of the right-pane reveal. */
export const FULL_CLIP_PATH = 'inset(0% 0% 0% 0%)';

/** Home overlay travel while it is pushed back behind an incoming section. */
export const HOME_OVERLAY_TRAVEL_PX = 24;

export const HOME_ROUTE_TRANSITION_KEY = 'home';

/**
 * First "app segment" of a pathname, workspace-slug aware:
 *
 * - `/` → `home`
 * - `/lobe-team` → `home`
 * - `/image` and `/lobe-team/image` → `image`
 * - `/agent/abc` → `agent`
 *
 * Segment granularity means in-section navigation (`/community` →
 * `/community/mcp`, `/agent/a` → `/agent/b`) does not re-run the transition —
 * only leaving one top-level area for another does.
 *
 * Single source of truth for both `NavPanel` and `RouteTransition`; the two used
 * to keep private copies that could drift.
 */
export const getMainRouteSegment = (pathname: string, activeSlug?: string | null): string => {
  const segments = pathname.split('/').filter(Boolean);
  const segment = activeSlug && segments[0] === activeSlug ? segments[1] : segments[0];
  return segment || HOME_ROUTE_TRANSITION_KEY;
};

/**
 * Nav keys (`NavPanelPortal navKey=…`) and route segments do not always agree:
 * community's portal registers `discover`, both `/image` and `/video` register
 * `image`, and the deep eval/resource sub-layouts register their own keys. Fold
 * them onto one canonical section id so a direction lookup cannot disagree with
 * itself depending on which side asked.
 */
const SECTION_ALIASES: Record<string, string> = {
  discover: 'community',
  evalBench: 'eval',
  resourceLibrary: 'resource',
  // `/task/:id` is the detail view of `/tasks`, and NavPanel keeps the home
  // sidebar on both — so they are one place, not two.
  task: 'tasks',
  video: 'image',
};

const normalizeSection = (key: string) => SECTION_ALIASES[key] ?? key;

/**
 * Hierarchy depth. Direction is derived from this table rather than from
 * `history`, which is wrong here: a refresh, a workspace-prefixed URL, a
 * `replace`, or a Cmd-click all produce histories that do not describe the
 * user's mental "level".
 */
const SECTION_DEPTH: Record<string, number> = {
  'agent': 2,
  'community': 1,
  'eval': 1,
  'fleet': 1,
  'group': 2,
  'home': 0,
  'image': 1,
  'memory': 1,
  'page': 1,
  'resource': 1,
  'settings': 2,
  // NavPanel intentionally keeps the home sidebar on `/tasks`, so tasks is a
  // sibling of home, not a child of it.
  'tasks': 0,
  'workspace-settings': 2,
};

/** Sibling reading order — used when both sides sit at the same depth. */
const SECTION_PEER_ORDER = [
  'home',
  'tasks',
  'page',
  'image',
  'community',
  'resource',
  'memory',
  'eval',
  'fleet',
  'agent',
  'group',
  'settings',
  'workspace-settings',
];

/** `1` = forward (deeper / later), `-1` = back, `0` = no directional cue. */
export type SectionDirection = -1 | 0 | 1;

/**
 * Direction of a section change, from the depth/peer table above.
 *
 * Returns `0` — a plain fade, no slide — whenever the move is not describable:
 * same canonical section (`/image` → `/video`), or a key that is not in the
 * table at all (`empty`, future sections). Guessing a direction there is worse
 * than not animating one.
 */
export const getSectionDirection = (from: string, to: string): SectionDirection => {
  const fromKey = normalizeSection(from);
  const toKey = normalizeSection(to);
  if (fromKey === toKey) return 0;

  const fromDepth = SECTION_DEPTH[fromKey];
  const toDepth = SECTION_DEPTH[toKey];
  if (fromDepth === undefined || toDepth === undefined) return 0;
  if (toDepth > fromDepth) return 1;
  if (toDepth < fromDepth) return -1;

  const fromIndex = SECTION_PEER_ORDER.indexOf(fromKey);
  const toIndex = SECTION_PEER_ORDER.indexOf(toKey);
  if (fromIndex === -1 || toIndex === -1) return 0;

  return toIndex > fromIndex ? 1 : -1;
};

/**
 * `+1` in LTR, `-1` in RTL: "forward" always means "in from the inline-end".
 * Read at render time (not module scope) so a runtime `dir` flip is picked up.
 */
export const getInlineSign = (): 1 | -1 => {
  if (typeof document === 'undefined') return 1;
  return document.documentElement.dir === 'rtl' ? -1 : 1;
};

/**
 * `clip-path` reveal for the right pane. Forward uncovers from the inline-end,
 * back from the inline-start; `0` is a full-bleed box so the animation degrades
 * to the opacity fade alone.
 */
export const getRevealClipPath = (direction: SectionDirection, inlineSign: 1 | -1): string => {
  const signed = direction * inlineSign;
  if (signed === 0) return FULL_CLIP_PATH;

  // signed > 0: content arrives from the right → keep the right edge, sweep left.
  return signed > 0
    ? `inset(0% 0% 0% ${MAIN_REVEAL_INSET_PERCENT}%)`
    : `inset(0% ${MAIN_REVEAL_INSET_PERCENT}% 0% 0%)`;
};
