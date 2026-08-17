import { describe, expect, it } from 'vitest';

import { decideInfraHydration } from './infraSettingsHydration';

describe('decideInfraHydration', () => {
  it('accepts the first snapshot', () => {
    expect(
      decideInfraHydration({ baselineFp: null, draftFp: null, nextFp: 'a', saving: false }),
    ).toEqual({ action: 'accept' });
  });

  it('ignores identity churn on an unchanged snapshot', () => {
    expect(
      decideInfraHydration({ baselineFp: 'a', draftFp: 'a', nextFp: 'a', saving: false }),
    ).toEqual({ action: 'keep', markStale: false });
  });

  it('adopts a changed snapshot while the draft is clean', () => {
    expect(
      decideInfraHydration({ baselineFp: 'a', draftFp: 'a', nextFp: 'b', saving: false }),
    ).toEqual({ action: 'accept' });
  });

  it('keeps a dirty draft and reports that the server moved', () => {
    expect(
      decideInfraHydration({ baselineFp: 'a', draftFp: 'edited', nextFp: 'b', saving: false }),
    ).toEqual({ action: 'keep', markStale: true });
  });

  it('never swaps the payload under an in-flight save', () => {
    expect(
      decideInfraHydration({ baselineFp: 'a', draftFp: 'a', nextFp: 'b', saving: true }),
    ).toEqual({ action: 'keep', markStale: true });
  });

  it('force-accepts an explicit reload even when the draft is dirty', () => {
    expect(
      decideInfraHydration({
        baselineFp: 'a',
        draftFp: 'edited',
        force: true,
        nextFp: 'b',
        saving: false,
      }),
    ).toEqual({ action: 'accept' });
  });
});
