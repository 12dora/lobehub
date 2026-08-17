import { describe, expect, it } from 'vitest';

import type { SubscriptionView } from '@/types/platform/networkProxy';

import {
  buildSubscriptionCreate,
  buildSubscriptionUpdate,
  createSubscriptionFormState,
  nextSortOrder,
  validateSubscriptionForm,
} from './subscriptionForm';

const stored = (overrides: Partial<SubscriptionView> = {}): SubscriptionView => ({
  createdAt: '2026-08-17T00:00:00.000Z',
  enabled: true,
  excludeFilter: undefined,
  filter: undefined,
  id: 'nps_1',
  kind: 'url',
  lastIssue: null,
  lastUpdateAt: '2026-08-17T01:00:00.000Z',
  name: 'Main',
  nodeCount: 12,
  sortOrder: 0,
  traffic: null,
  updateIntervalSec: 86_400,
  updatedAt: '2026-08-17T01:00:00.000Z',
  urlHost: 'sub.example.com',
  userAgent: null,
  ...overrides,
});

describe('createSubscriptionFormState', () => {
  it('never seeds the URL or the paste — the server does not return them', () => {
    const state = createSubscriptionFormState(stored());
    expect(state.url).toBe('');
    expect(state.payload).toBe('');
    expect(state.name).toBe('Main');
  });

  it('defaults a new subscription to an enabled URL subscription', () => {
    const state = createSubscriptionFormState();
    expect(state).toMatchObject({ enabled: true, kind: 'url' });
  });
});

describe('validateSubscriptionForm', () => {
  const base = createSubscriptionFormState();

  it('requires a name', () => {
    expect(validateSubscriptionForm({ ...base, name: '  ' }, 'create')).toBe('nameRequired');
  });

  it('requires a URL on create but not on edit', () => {
    const state = { ...base, name: 'x' };
    expect(validateSubscriptionForm(state, 'create')).toBe('urlRequired');
    expect(validateSubscriptionForm(state, 'edit')).toBeNull();
  });

  it('rejects a non-http URL', () => {
    expect(validateSubscriptionForm({ ...base, name: 'x', url: 'ftp://a/b' }, 'create')).toBe(
      'urlInvalid',
    );
  });

  it('rejects an out-of-range update interval', () => {
    expect(
      validateSubscriptionForm(
        { ...base, name: 'x', updateIntervalSec: 5, url: 'https://a/b' },
        'create',
      ),
    ).toBe('intervalRange');
  });

  it('requires a paste for a manual subscription on create only', () => {
    const state = { ...base, kind: 'manual' as const, name: 'x' };
    expect(validateSubscriptionForm(state, 'create')).toBe('payloadRequired');
    expect(validateSubscriptionForm(state, 'edit')).toBeNull();
  });
});

describe('buildSubscriptionCreate', () => {
  it('builds a URL subscription and omits blank optionals', () => {
    const input = buildSubscriptionCreate(
      { ...createSubscriptionFormState(), name: ' Main ', url: ' https://sub.example.com/x ' },
      3,
    );
    expect(input).toEqual({
      enabled: true,
      kind: 'url',
      name: 'Main',
      sortOrder: 3,
      updateIntervalSec: 86_400,
      url: 'https://sub.example.com/x',
    });
  });

  it('builds a manual subscription with the raw paste', () => {
    const input = buildSubscriptionCreate(
      {
        ...createSubscriptionFormState(),
        excludeFilter: ' bad ',
        kind: 'manual',
        name: 'Pasted',
        payload: 'vless://a\nss://b',
      },
      0,
    );
    expect(input).toMatchObject({
      excludeFilter: 'bad',
      kind: 'manual',
      payload: 'vless://a\nss://b',
    });
  });
});

describe('buildSubscriptionUpdate', () => {
  it('only sends what changed', () => {
    const original = stored();
    const patch = buildSubscriptionUpdate(original, {
      ...createSubscriptionFormState(original),
      name: 'Renamed',
    });
    expect(patch).toEqual({ id: 'nps_1', name: 'Renamed' });
  });

  it('never sends a blank URL — that would be read as a change', () => {
    const original = stored();
    const patch = buildSubscriptionUpdate(original, createSubscriptionFormState(original));
    expect('url' in patch).toBe(false);
    expect('payload' in patch).toBe(false);
  });

  it('sends a replacement URL when one is typed', () => {
    const original = stored();
    const patch = buildSubscriptionUpdate(original, {
      ...createSubscriptionFormState(original),
      url: ' https://new.example.com/s ',
    });
    expect(patch.url).toBe('https://new.example.com/s');
  });

  it('clears an emptied filter with null rather than an empty string', () => {
    const original = stored({ filter: 'HK' });
    const patch = buildSubscriptionUpdate(original, {
      ...createSubscriptionFormState(original),
      filter: '',
    });
    expect(patch.filter).toBeNull();
  });
});

describe('nextSortOrder', () => {
  it('appends after the highest existing order', () => {
    expect(nextSortOrder([stored({ sortOrder: 0 }), stored({ sortOrder: 7 })])).toBe(8);
  });

  it('starts at 0 for an empty list', () => {
    expect(nextSortOrder([])).toBe(0);
  });
});
