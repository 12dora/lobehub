import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSetupGuideDismissal,
  dismissSetupGuide,
  isSetupGuideDismissed,
  SETUP_GUIDE_DISMISSED_KEY,
} from './setupGuideDismissal';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('setup guide dismissal', () => {
  it('is not dismissed on a fresh session', () => {
    expect(isSetupGuideDismissed()).toBe(false);
  });

  it('survives a remount within the session', () => {
    dismissSetupGuide();
    expect(window.sessionStorage.getItem(SETUP_GUIDE_DISMISSED_KEY)).toBe('1');
    // Component state was the bug: navigating away and back used to bring the card straight back.
    expect(isSetupGuideDismissed()).toBe(true);
  });

  it('uses one key, so the card and the wizard exit dismiss the same thing', () => {
    dismissSetupGuide();
    expect(isSetupGuideDismissed()).toBe(true);
    clearSetupGuideDismissal();
    expect(isSetupGuideDismissed()).toBe(false);
  });

  it('keeps showing the guide when storage is unavailable, rather than throwing', () => {
    vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    vi.spyOn(window.sessionStorage, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });

    expect(() => dismissSetupGuide()).not.toThrow();
    expect(isSetupGuideDismissed()).toBe(false);
  });
});
