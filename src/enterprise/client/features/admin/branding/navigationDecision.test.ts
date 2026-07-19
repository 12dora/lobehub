import { describe, expect, it, vi } from 'vitest';

import { createBrandingNavigationDecision } from './navigationDecision';

describe('Branding dirty navigation decision', () => {
  it('proceeds exactly once when modal events race', () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    const decision = createBrandingNavigationDecision({ onCancel, onProceed });

    decision.proceed();
    decision.proceed();
    decision.cancel();

    expect(onProceed).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels exactly once and cannot later proceed', () => {
    const onCancel = vi.fn();
    const onProceed = vi.fn();
    const decision = createBrandingNavigationDecision({ onCancel, onProceed });

    decision.cancel();
    decision.cancel();
    decision.proceed();

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onProceed).not.toHaveBeenCalled();
  });
});
