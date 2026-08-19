// @vitest-environment node
import { describe, expect, it } from 'vitest';

import type { IdentityProviderLkgPayload, IdentityProviderLkgProvider } from './codec';
import { compareSnapshots, IDENTITY_PROVIDER_LKG_VERSION, LKG_DOMAIN } from './codec';

const CHECKSUM_A = 'a'.repeat(64);
const CHECKSUM_B = 'b'.repeat(64);
const FINGERPRINT_A = 'c'.repeat(64);
const FINGERPRINT_B = 'd'.repeat(64);
const GEN_EARLY = '2026-01-01T00:00:00.000Z:3';
const GEN_LATER = '2026-06-01T00:00:00.000Z:4';
const GEN_TOMBSTONE = '2026-12-01T00:00:00.000Z:tombstone';

const liveProvider = (
  overrides: Partial<IdentityProviderLkgProvider> = {},
): IdentityProviderLkgProvider => ({
  checksum: CHECKSUM_A,
  generation: GEN_EARLY,
  payload: { providerKey: 'corp' },
  providerId: 'provider-1',
  revision: 3,
  secretCiphertext: 'aihub.secret.v1.test',
  secretFingerprint: FINGERPRINT_A,
  ...overrides,
});

const snapshot = (
  overrides: Partial<IdentityProviderLkgPayload> = {},
): IdentityProviderLkgPayload => ({
  createdAt: '2026-01-01T00:00:00.000Z',
  domain: LKG_DOMAIN,
  generation: GEN_EARLY,
  identityRevision: CHECKSUM_A,
  providerTombstones: [],
  providers: [liveProvider()],
  version: IDENTITY_PROVIDER_LKG_VERSION,
  ...overrides,
});

describe('compareSnapshots', () => {
  it.each([
    {
      candidate: snapshot({
        identityRevision: 'id-same',
        providerTombstones: [{ generation: GEN_TOMBSTONE, providerId: 'provider-old' }],
      }),
      current: snapshot({
        identityRevision: 'id-same',
        providerTombstones: [{ generation: GEN_TOMBSTONE, providerId: 'provider-old' }],
      }),
      expected: 'unchanged' as const,
      name: 'same identity + same tombstones',
    },
    {
      candidate: snapshot({ generation: GEN_EARLY, identityRevision: 'id-older' }),
      current: snapshot({ generation: GEN_LATER, identityRevision: 'id-current' }),
      expected: 'rejected' as const,
      name: 'candidate generation strictly less than current',
    },
    {
      candidate: snapshot({ generation: GEN_LATER, identityRevision: 'id-other' }),
      current: snapshot({ generation: GEN_LATER, identityRevision: 'id-current' }),
      expected: 'rejected' as const,
      name: 'candidate generation equal to current with different identity',
    },
    {
      candidate: snapshot({
        generation: GEN_TOMBSTONE,
        identityRevision: 'id-live',
        providers: [liveProvider({ generation: GEN_TOMBSTONE })],
      }),
      current: snapshot({
        generation: GEN_EARLY,
        identityRevision: 'id-empty',
        providerTombstones: [{ generation: GEN_TOMBSTONE, providerId: 'provider-1' }],
        providers: [],
      }),
      expected: 'rejected' as const,
      name: 'candidate provider generation equal to current tombstone for that id',
    },
    {
      candidate: snapshot({
        generation: GEN_LATER,
        identityRevision: 'id-live',
        providers: [liveProvider({ generation: GEN_EARLY })],
      }),
      current: snapshot({
        generation: GEN_EARLY,
        identityRevision: 'id-empty',
        providerTombstones: [{ generation: GEN_TOMBSTONE, providerId: 'provider-1' }],
        providers: [],
      }),
      expected: 'rejected' as const,
      name: 'candidate provider generation less than current tombstone for that id',
    },
    {
      candidate: snapshot({
        generation: GEN_LATER,
        identityRevision: 'id-b',
        providers: [liveProvider({ checksum: CHECKSUM_B })],
      }),
      current: snapshot({ generation: GEN_EARLY, identityRevision: 'id-a' }),
      expected: 'rejected' as const,
      name: 'same revision but checksum mismatch',
    },
    {
      candidate: snapshot({
        generation: GEN_LATER,
        identityRevision: 'id-b',
        providers: [liveProvider({ secretFingerprint: FINGERPRINT_B })],
      }),
      current: snapshot({ generation: GEN_EARLY, identityRevision: 'id-a' }),
      expected: 'rejected' as const,
      name: 'same revision but secretFingerprint mismatch',
    },
    {
      candidate: snapshot({
        generation: GEN_LATER,
        identityRevision: 'id-b',
        providers: [liveProvider({ generation: `${GEN_EARLY}-other` })],
      }),
      current: snapshot({ generation: GEN_EARLY, identityRevision: 'id-a' }),
      expected: 'rejected' as const,
      name: 'same revision but provider generation mismatch',
    },
    {
      candidate: snapshot({
        generation: GEN_TOMBSTONE,
        identityRevision: 'id-empty',
        providers: [],
      }),
      current: snapshot({
        generation: GEN_EARLY,
        identityRevision: 'id-live',
        providers: [liveProvider()],
      }),
      expected: 'upgrade' as const,
      name: 'higher generation + provider dropped',
    },
    {
      candidate: snapshot({
        generation: GEN_TOMBSTONE,
        identityRevision: 'id-same',
        providerTombstones: [{ generation: GEN_TOMBSTONE, providerId: 'provider-old' }],
        providers: [liveProvider()],
      }),
      current: snapshot({
        generation: GEN_EARLY,
        identityRevision: 'id-same',
        providerTombstones: [],
        providers: [liveProvider()],
      }),
      expected: 'upgrade' as const,
      name: 'same live set + newer tombstone',
    },
  ])('$name → $expected', ({ candidate, current, expected }) => {
    expect(compareSnapshots(current, candidate)).toBe(expected);
  });
});
