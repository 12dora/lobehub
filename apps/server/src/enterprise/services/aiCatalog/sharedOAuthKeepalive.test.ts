// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runSharedOAuthKeepaliveSweep } from './sharedOAuthKeepalive';
import type * as SharedOAuthRefreshModule from './sharedOAuthRefresh';

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));

vi.mock('./sharedOAuthRefresh', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedOAuthRefreshModule>()),
  refreshSharedOAuthVault: mockRefresh,
}));

const DAY_MS = 24 * 60 * 60 * 1000;

const encryptVault = (vault: object) => `enc:${JSON.stringify(vault)}`;

const secrets = {
  decrypt: (ciphertext: string) => Promise.resolve(JSON.parse(ciphertext.replace(/^enc:/, ''))),
} as any;

interface ProviderRow {
  ciphertext: string | null;
  fingerprint: string | null;
  id: string;
  providerKey: string;
}

/**
 * Chainable drizzle stub.
 * - `insert(...).values(...).onConflictDoNothing()` seeds the lease row
 * - `update(...).set(...).where(...).returning()` is the lease claim / park
 * - `select(...).from(...).where(...).orderBy(...)` is the candidate scan
 */
const makeDb = (params: {
  claim?: Array<{ id: string }>;
  /** Make the cadence park (the only update that sets `finishedAt`) reject. */
  parkFails?: boolean;
  rows?: ProviderRow[];
}) => {
  const updates: Array<Record<string, unknown>> = [];
  const claim = params.claim ?? [{ id: 'job-1' }];
  let claimCalls = 0;
  const rejectingChain: any = { where: () => Promise.reject(new Error('db down')) };
  const writeChain: any = {
    onConflictDoNothing: () => Promise.resolve(),
    returning: () => Promise.resolve(claimCalls++ === 0 ? claim : []),
    set: (values: Record<string, unknown>) => {
      updates.push(values);
      return params.parkFails && 'finishedAt' in values ? rejectingChain : writeChain;
    },
    values: () => writeChain,
    where: () => writeChain,
  };
  const readChain: any = {
    from: () => readChain,
    orderBy: () => Promise.resolve(params.rows ?? []),
    where: () => readChain,
  };
  return {
    db: {
      insert: () => writeChain,
      select: () => readChain,
      update: () => writeChain,
    } as any,
    updates,
  };
};

const dueVault = (overrides: object = {}) => ({
  oauthAccessToken: 'at-old',
  oauthLastRefreshAt: String(Date.now() - 4 * DAY_MS),
  oauthRefreshToken: 'rt-old',
  oauthTokenExpiresAt: String(Date.now() + 60 * 60 * 1000),
  ...overrides,
});

const row = (providerKey: string, vault: object): ProviderRow => ({
  ciphertext: encryptVault(vault),
  fingerprint: 'sha256:stable',
  id: `row_${providerKey}`,
  providerKey,
});

describe('runSharedOAuthKeepaliveSweep', () => {
  beforeEach(() => {
    mockRefresh.mockReset();
    mockRefresh.mockResolvedValue({});
  });

  it('force-renews a shared credential whose last refresh is older than 3 days', async () => {
    const { db } = makeDb({ rows: [row('chatgptweb', dueVault())] });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ claimed: true, failed: 0, refreshed: 1, scanned: 1 });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh.mock.calls[0][0]).toMatchObject({
      fingerprint: 'sha256:stable',
      // Forced: the access token is still valid, only the refresh token needs exercising.
      force: true,
      providerKey: 'chatgptweb',
      providerRowId: 'row_chatgptweb',
    });
  });

  it('skips a credential renewed inside the keepalive window', async () => {
    const { db } = makeDb({
      rows: [
        row(
          'chatgptweb',
          dueVault({
            oauthLastRefreshAt: String(Date.now() - DAY_MS),
            // Outside ChatGPT Web's 24 h proactive window too, so only the keepalive
            // cadence is under test here.
            oauthTokenExpiresAt: String(Date.now() + 2 * DAY_MS),
          }),
        ),
      ],
    });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ refreshed: 0, scanned: 1 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  /**
   * The sweep evaluates the SAME policy as every other refresh path instead of re-deriving
   * its own gate from the individual predicates — that drift is what dropped the
   * expired-token exception below.
   */
  it('renews a shared credential inside the provider’s proactive skew window', async () => {
    const { db } = makeDb({
      rows: [
        // ChatGPT Web declares a 24 h skew; 1 h of remaining life is well inside it.
        row('chatgptweb', dueVault({ oauthLastRefreshAt: String(Date.now() - DAY_MS) })),
      ],
    });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ refreshed: 1, scanned: 1 });
  });

  it('renews an already-expired credential despite a recent failure stamp', async () => {
    const { db } = makeDb({
      rows: [
        row(
          'supergrok',
          dueVault({
            oauthLastRefreshErrorAt: String(Date.now() - 60 * 1000),
            oauthTokenExpiresAt: String(Date.now() - 1000),
          }),
        ),
      ],
    });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    // Backing off here protects nothing — there is no working access token left, and the
    // shared connection would stay dead for every member until the window closed.
    expect(result).toMatchObject({ refreshed: 1, scanned: 1 });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it('skips a credential inside its post-failure backoff window', async () => {
    const { db } = makeDb({
      rows: [
        row('chatgptweb', dueVault({ oauthLastRefreshErrorAt: String(Date.now() - 60 * 1000) })),
      ],
    });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ refreshed: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('skips a pasted access token that has no refresh grant to keep alive', async () => {
    const { db } = makeDb({
      rows: [row('chatgptweb', { oauthAccessToken: 'at-only' })],
    });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ refreshed: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('does nothing when another replica holds the sweep lease', async () => {
    const { db } = makeDb({ claim: [], rows: [row('chatgptweb', dueVault())] });

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toEqual({ claimed: false, failed: 0, parked: false, refreshed: 0, scanned: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('caps the batch so one tick cannot renew every provider at once', async () => {
    const { db } = makeDb({
      rows: [
        row('chatgpt', dueVault()),
        row('chatgptweb', dueVault()),
        row('supergrok', dueVault()),
      ],
    });

    const result = await runSharedOAuthKeepaliveSweep({ batchSize: 2, db, secrets });

    expect(result).toMatchObject({ refreshed: 2 });
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it('keeps sweeping after one provider fails and parks the lease for the next window', async () => {
    // Provider prose, complete with echoed credential material — none of it may be logged.
    mockRefresh.mockRejectedValueOnce(
      new Error('Failed to refresh access token: 400 invalid_request refresh_token=rt-secret'),
    );
    const { db, updates } = makeDb({
      rows: [row('chatgpt', dueVault()), row('chatgptweb', dueVault())],
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    expect(result).toMatchObject({ failed: 1, parked: true, refreshed: 2 });
    const logged = consoleError.mock.calls.flat().join(' ');
    expect(logged).toContain('provider=chatgpt');
    expect(logged).toContain('category=transient');
    expect(logged).toContain('errorClass=Error');
    expect(logged).not.toContain('rt-secret');
    expect(logged).not.toContain('invalid_request');
    consoleError.mockRestore();

    // The parking write clears the owner but keeps a future leaseUntil: that is what
    // holds every replica to the hourly cadence instead of re-sweeping minutes later.
    const parked = updates.at(-1)!;
    expect(parked.leaseOwner).toBeNull();
    expect(parked.leaseUntil).toBeDefined();
    expect(parked.status).toBe('succeeded');
  });

  it('reports a failed cadence park instead of silently falling back to the crash lease', async () => {
    const { db } = makeDb({ parkFails: true, rows: [row('chatgptweb', dueVault())] });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets });

    // The sweep itself succeeded, but the hourly window was never written: the row now
    // reopens when the 15-minute crash lease expires, which the caller has to be able to see.
    expect(result).toMatchObject({ claimed: true, parked: false, refreshed: 1 });
    expect(consoleError.mock.calls.flat().join(' ')).toContain('could not park the sweep lease');
    consoleError.mockRestore();
  });

  it('does not renew a credential that cannot be decrypted', async () => {
    const { db } = makeDb({ rows: [row('chatgptweb', dueVault())] });
    const failing = { decrypt: () => Promise.reject(new Error('PLATFORM_SECRET_NOT_READABLE')) };

    const result = await runSharedOAuthKeepaliveSweep({ db, secrets: failing as any });

    expect(result).toMatchObject({ failed: 1, refreshed: 0, scanned: 1 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
