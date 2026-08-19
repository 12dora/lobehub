import { shouldConfirmSkillHydration } from './controller';

export type SkillHydrationDecision =
  | { type: 'already-hydrated' }
  | { type: 'hydrate-allowed' }
  | { type: 'skip-rejected' }
  | { type: 'confirm' }
  | { type: 'hydrate' };

export function decideSkillHydration(input: {
  allowedSkillId: string | null;
  currentHydrationKey: string | null;
  dirty: boolean;
  hasSafeRecovery: boolean;
  hydrationKey: string;
  rejectedHydrationKey: string | null;
  snapshotSkillId: string;
}): SkillHydrationDecision {
  if (input.currentHydrationKey === input.hydrationKey) {
    return { type: 'already-hydrated' };
  }
  if (input.allowedSkillId === input.snapshotSkillId) {
    return { type: 'hydrate-allowed' };
  }
  if (input.rejectedHydrationKey === input.hydrationKey) {
    return { type: 'skip-rejected' };
  }
  if (
    shouldConfirmSkillHydration({
      currentHydrationKey: input.currentHydrationKey,
      dirty: input.dirty,
      hasSafeRecovery: input.hasSafeRecovery,
      nextHydrationKey: input.hydrationKey,
    })
  ) {
    return { type: 'confirm' };
  }
  return { type: 'hydrate' };
}
