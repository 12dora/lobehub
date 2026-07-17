import { lambdaClient } from '@/libs/trpc/client';

import type { AdminAgentsClient } from '../features/admin/agents/types';

/**
 * Raised by the production adapter when a caller reaches for a rollout action that has no
 * backend yet. PR-052 (`admin.agents.rollouts.*`) is not implemented, so the lambda adapter
 * advertises `capabilities.rollouts === false` and every rollout method fails loudly here
 * instead of silently falling back to mock data or faking a successful job.
 */
export class PlatformAgentRolloutUnavailableError extends Error {
  constructor() {
    super('PLATFORM_AGENT_ROLLOUT_UNAVAILABLE');
    this.name = 'PlatformAgentRolloutUnavailableError';
  }
}

const rolloutUnavailable = (): never => {
  throw new PlatformAgentRolloutUnavailableError();
};

/**
 * Production adapter backed by the reviewed M10 core routers (`admin.agents.*`).
 *
 * Every method forwards its already-contract-typed input straight to the matching TRPC
 * procedure — no client-side Zod, no `any`, no mock data. Network / router errors surface to
 * the UI unchanged so they reach the error / retry surfaces instead of being masked as empty.
 *
 * Rollout actions have no core router yet (PR-052), so they are gated off via
 * `capabilities.rollouts` and throw {@link PlatformAgentRolloutUnavailableError} if invoked.
 * Tests that need executable rollout behaviour inject `createMockAdminAgentsClient()` explicitly.
 */
export const createLambdaAdminAgentsClient = (): AdminAgentsClient => ({
  capabilities: { rollouts: false },

  appendVersion: (input) => lambdaClient.admin.agents.appendVersion.mutate(input),
  archive: (input) => lambdaClient.admin.agents.archive.mutate(input),
  cancelRollout: rolloutUnavailable,
  create: (input) => lambdaClient.admin.agents.create.mutate(input),
  get: (input) => lambdaClient.admin.agents.get.query(input),
  getDependents: (input) => lambdaClient.admin.agents.getDependents.query(input),
  getRollout: rolloutUnavailable,
  list: (input) => lambdaClient.admin.agents.list.query(input),
  listAssignments: (input) => lambdaClient.admin.agents.assignments.list.query(input),
  listRollouts: rolloutUnavailable,
  listVersions: (input) => lambdaClient.admin.agents.listVersions.query(input),
  previewAssignment: (input) => lambdaClient.admin.agents.assignments.preview.query(input),
  publish: (input) => lambdaClient.admin.agents.publish.mutate(input),
  removeAssignment: (input) => lambdaClient.admin.agents.assignments.remove.mutate(input),
  retryRollout: rolloutUnavailable,
  rollback: (input) => lambdaClient.admin.agents.rollback.mutate(input),
  rollbackRollout: rolloutUnavailable,
  setDefaultInbox: (input) => lambdaClient.admin.agents.setDefaultInbox.mutate(input),
  startRollout: rolloutUnavailable,
  updateDraft: (input) => lambdaClient.admin.agents.updateDraft.mutate(input),
  upsertAssignment: (input) => lambdaClient.admin.agents.assignments.upsert.mutate(input),
  validateDependencies: (input) => lambdaClient.admin.agents.validateDependencies.mutate(input),
});

/**
 * PR-050 adapter seam. Production resolves to the real `admin.agents.*` lambda adapter; the
 * mock client is reserved for explicit test injection and never becomes the runtime default.
 */
export const adminAgentsService: AdminAgentsClient = createLambdaAdminAgentsClient();
