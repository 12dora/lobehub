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

  it('treats passive dismiss (Escape/close/mask) as cancel without later proceed', () => {
    // useUnsavedChangesGuard wires createModal onOpenChange(false) → decision.cancel()
    // so passive dismissals reset the router blocker instead of stranding it.
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    const decision = createUnsavedNavigationDecision({ onCancel, onProceed });

    decision.cancel(); // simulate onOpenChange(false) from Escape / close icon
    decision.proceed(); // late button event after dismiss must be ignored

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onProceed).not.toHaveBeenCalled();
  });
});
