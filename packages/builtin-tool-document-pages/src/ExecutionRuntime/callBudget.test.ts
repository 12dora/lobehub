// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDocumentPagesCallBudget,
  DOCUMENT_PAGES_CALL_LIMIT,
  resetDocumentPagesCallBudgetForTest,
} from './callBudget';

describe('createDocumentPagesCallBudget', () => {
  afterEach(() => {
    resetDocumentPagesCallBudgetForTest();
    vi.useRealTimers();
  });

  it('allows `limit` calls then refuses', () => {
    const budget = createDocumentPagesCallBudget({
      limit: DOCUMENT_PAGES_CALL_LIMIT,
      ttlMs: 60_000,
    });

    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 1 });
    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 2 });
    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 3 });
    expect(budget.consume('turn-1')).toEqual({ allowed: false, used: 4 });
  });

  it('tracks keys independently', () => {
    const budget = createDocumentPagesCallBudget({ limit: 1, ttlMs: 60_000 });

    expect(budget.consume('a').allowed).toBe(true);
    expect(budget.consume('b').allowed).toBe(true);
    expect(budget.consume('a').allowed).toBe(false);
  });

  it('resets a key after TTL expiry', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T12:00:00Z'));
    const budget = createDocumentPagesCallBudget({ limit: 3, ttlMs: 1000 });

    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 1 });
    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 2 });
    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 3 });
    expect(budget.consume('turn-1').allowed).toBe(false);

    vi.advanceTimersByTime(1001);

    expect(budget.consume('turn-1')).toEqual({ allowed: true, used: 1 });
  });
});
