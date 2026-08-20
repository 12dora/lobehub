import { afterEach, describe, expect, it } from 'vitest';

import {
  FULL_CLIP_PATH,
  getInlineSign,
  getMainRouteSegment,
  getRevealClipPath,
  getSectionDirection,
  MAIN_REVEAL_INSET_PERCENT,
  SECTION_TRANSITION_MS,
  SECTION_TRANSITION_S,
} from './timing';

describe('section clock', () => {
  it('exposes the same duration in both units', () => {
    expect(SECTION_TRANSITION_MS).toBe(280);
    expect(SECTION_TRANSITION_S).toBe(SECTION_TRANSITION_MS / 1000);
  });
});

describe('getMainRouteSegment', () => {
  it('maps the root path to the home key', () => {
    expect(getMainRouteSegment('/', null)).toBe('home');
    expect(getMainRouteSegment('', null)).toBe('home');
  });

  it('uses the first path segment', () => {
    expect(getMainRouteSegment('/image', null)).toBe('image');
    expect(getMainRouteSegment('/community/mcp', null)).toBe('community');
    expect(getMainRouteSegment('/agent/abc-123', null)).toBe('agent');
  });

  it('skips the active workspace slug', () => {
    expect(getMainRouteSegment('/lobe-team', 'lobe-team')).toBe('home');
    expect(getMainRouteSegment('/lobe-team/', 'lobe-team')).toBe('home');
    expect(getMainRouteSegment('/lobe-team/image', 'lobe-team')).toBe('image');
    expect(getMainRouteSegment('/lobe-team/agent/abc', 'lobe-team')).toBe('agent');
  });

  it('does not strip a segment that only looks like the slug', () => {
    expect(getMainRouteSegment('/image', 'lobe-team')).toBe('image');
  });

  it('works without an explicit slug argument', () => {
    expect(getMainRouteSegment('/settings/common')).toBe('settings');
  });
});

describe('getSectionDirection', () => {
  it('goes forward when the target sits deeper in the hierarchy', () => {
    expect(getSectionDirection('home', 'image')).toBe(1);
    expect(getSectionDirection('home', 'agent')).toBe(1);
    expect(getSectionDirection('image', 'settings')).toBe(1);
  });

  it('goes back when the target sits shallower', () => {
    expect(getSectionDirection('settings', 'home')).toBe(-1);
    expect(getSectionDirection('agent', 'community')).toBe(-1);
    expect(getSectionDirection('image', 'home')).toBe(-1);
  });

  it('falls back to peer reading order at equal depth', () => {
    expect(getSectionDirection('image', 'community')).toBe(1);
    expect(getSectionDirection('memory', 'page')).toBe(-1);
    expect(getSectionDirection('home', 'tasks')).toBe(1);
    expect(getSectionDirection('agent', 'group')).toBe(1);
    expect(getSectionDirection('group', 'agent')).toBe(-1);
  });

  it('treats the nav key and the route key of one section as the same place', () => {
    // Community's NavPanelPortal registers `discover`, its route segment is `community`.
    expect(getSectionDirection('discover', 'community')).toBe(0);
    expect(getSectionDirection('home', 'discover')).toBe(1);
    expect(getSectionDirection('discover', 'home')).toBe(-1);

    // `/image` and `/video` share one sidebar (navKey="image").
    expect(getSectionDirection('image', 'video')).toBe(0);
    expect(getSectionDirection('video', 'settings')).toBe(1);

    // Deep sub-layouts register their own nav keys.
    expect(getSectionDirection('eval', 'evalBench')).toBe(0);
    expect(getSectionDirection('resource', 'resourceLibrary')).toBe(0);

    // `/task/:id` is the detail view of `/tasks`; NavPanel keeps the home sidebar
    // on both, so they must resolve to the same place.
    expect(getSectionDirection('tasks', 'task')).toBe(0);
    expect(getSectionDirection('task', 'tasks')).toBe(0);
  });

  it('treats a task detail route as a peer of home, like the task list', () => {
    expect(getSectionDirection('home', 'task')).toBe(1);
    expect(getSectionDirection('task', 'home')).toBe(-1);
    expect(getSectionDirection('task', 'agent')).toBe(1);
    expect(getSectionDirection('settings', 'task')).toBe(-1);
  });

  it('reads the same direction off a workspace-prefixed path as off a bare one', () => {
    const bare = getSectionDirection(
      getMainRouteSegment('/', null),
      getMainRouteSegment('/task/task-1', null),
    );
    const prefixed = getSectionDirection(
      getMainRouteSegment('/lobe-team', 'lobe-team'),
      getMainRouteSegment('/lobe-team/task/task-1', 'lobe-team'),
    );

    expect(bare).toBe(1);
    expect(prefixed).toBe(bare);
    expect(
      getSectionDirection(
        getMainRouteSegment('/lobe-team/tasks', 'lobe-team'),
        getMainRouteSegment('/lobe-team/task/task-1', 'lobe-team'),
      ),
    ).toBe(0);
  });

  it('gives no directional cue for keys outside the table', () => {
    expect(getSectionDirection('home', 'empty')).toBe(0);
    expect(getSectionDirection('empty', 'home')).toBe(0);
    expect(getSectionDirection('home', 'home')).toBe(0);
  });
});

describe('getRevealClipPath', () => {
  it('uncovers from the inline-end going forward', () => {
    expect(getRevealClipPath(1, 1)).toBe(`inset(0% 0% 0% ${MAIN_REVEAL_INSET_PERCENT}%)`);
  });

  it('uncovers from the inline-start going back', () => {
    expect(getRevealClipPath(-1, 1)).toBe(`inset(0% ${MAIN_REVEAL_INSET_PERCENT}% 0% 0%)`);
  });

  it('mirrors under rtl', () => {
    expect(getRevealClipPath(1, -1)).toBe(getRevealClipPath(-1, 1));
    expect(getRevealClipPath(-1, -1)).toBe(getRevealClipPath(1, 1));
  });

  it('degrades to a plain fade without a direction', () => {
    expect(getRevealClipPath(0, 1)).toBe(FULL_CLIP_PATH);
  });

  it('never emits a transform', () => {
    for (const direction of [-1, 0, 1] as const) {
      expect(getRevealClipPath(direction, 1)).not.toMatch(/translate|matrix|scale/);
    }
  });
});

describe('getInlineSign', () => {
  afterEach(() => {
    document.documentElement.dir = '';
  });

  it('is positive in ltr and negative in rtl', () => {
    expect(getInlineSign()).toBe(1);
    document.documentElement.dir = 'rtl';
    expect(getInlineSign()).toBe(-1);
  });
});
