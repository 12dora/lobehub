import { describe, expect, it } from 'vitest';

import { adminSystemRequestRestartOutputSchema } from './adminSystem';

describe('admin system restart acceptance output', () => {
  it('requires durable acceptance time and exact target revision evidence', () => {
    const accepted = {
      accepted: true,
      acceptedAt: new Date('2026-07-19T00:00:00Z'),
      duplicate: false,
      expectedIdentityRevision: 'a'.repeat(64),
      requestId: '550e8400-e29b-41d4-a716-446655440056',
      status: 'accepted',
    };
    expect(adminSystemRequestRestartOutputSchema.parse(accepted)).toEqual(accepted);
    const { acceptedAt: _acceptedAt, ...withoutAcceptedAt } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutAcceptedAt)).toThrow();
    const { expectedIdentityRevision: _revision, ...withoutRevision } = accepted;
    expect(() => adminSystemRequestRestartOutputSchema.parse(withoutRevision)).toThrow();
  });
});
