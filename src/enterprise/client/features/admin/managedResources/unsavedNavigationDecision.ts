export interface UnsavedNavigationDecision {
  cancel: () => void;
  proceed: () => void;
}

/** Ensures a blocked navigation resolves exactly once even under repeated modal events. */
export const createUnsavedNavigationDecision = (callbacks: {
  onCancel: () => void;
  onProceed: () => void;
}): UnsavedNavigationDecision => {
  let resolved = false;
  const resolveOnce = (callback: () => void) => {
    if (resolved) return;
    resolved = true;
    callback();
  };
  return {
    cancel: () => resolveOnce(callbacks.onCancel),
    proceed: () => resolveOnce(callbacks.onProceed),
  };
};
