import { describe, expect, it, vi } from 'vitest';

import { createUnsavedNavigationDecision } from '../primitives/useUnsavedChangesGuard';

describe('unsaved managed policy navigation decision', () => {
  it('proceeds exactly once when duplicate modal events race', () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    const decision = createUnsavedNavigationDecision({ onCancel, onProceed });

    decision.proceed();
    decision.proceed();
    decision.cancel();

    expect(onProceed).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('resets exactly once and cannot later proceed', () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    const decision = createUnsavedNavigationDecision({ onCancel, onProceed });

    decision.cancel();
    decision.cancel();
    decision.proceed();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onProceed).not.toHaveBeenCalled();
  });
});
