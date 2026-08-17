'use client';

/**
 * "稍后再说" for the first-run guide.
 *
 * Component state was wrong twice over: navigating away and back remounted the card, and
 * leaving the wizard did not count as dismissing it. The deployment is still unconfigured, so
 * the reminder *should* come back — but on the next session, not on the next route change.
 * `sessionStorage` is exactly that lifetime, and one shared key keeps the card and the wizard's
 * exit talking about the same thing.
 */
export const SETUP_GUIDE_DISMISSED_KEY = 'lobehub:admin:setup-guide-dismissed';

const storage = (): Storage | null => {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Private-mode / disabled storage: the guide simply keeps showing, which is the safe side.
    return null;
  }
};

export const isSetupGuideDismissed = (): boolean => {
  try {
    return storage()?.getItem(SETUP_GUIDE_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
};

export const dismissSetupGuide = (): void => {
  try {
    storage()?.setItem(SETUP_GUIDE_DISMISSED_KEY, '1');
  } catch {
    // Nothing to recover: the card stays visible for this session.
  }
};

/** Completing the wizard makes the marker meaningless — drop it so a later reset shows again. */
export const clearSetupGuideDismissal = (): void => {
  try {
    storage()?.removeItem(SETUP_GUIDE_DISMISSED_KEY);
  } catch {
    // ignore
  }
};
