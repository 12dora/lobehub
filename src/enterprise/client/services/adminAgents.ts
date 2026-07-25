import { lambdaClient } from '@/libs/trpc/client';

import type { AdminAgentsClient } from '../features/admin/agents/types';

/**
 * Production adapter backed by the reviewed M10 core routers (`admin.agents.*`).
 *
 * Every method forwards its already-contract-typed input straight to the matching TRPC
 * procedure — no client-side Zod, no `any`, no mock data. Network / router errors surface to
 * the UI unchanged so they reach the error / retry surfaces instead of being masked as empty.
 *
 * Rollout actions use the real `admin.agents.rollouts.*` router. The server feature gate executes
 * before database middleware work, while the platform capability snapshot keeps the admin surface
 * disabled when managed Agents are off.
 */
export const createLambdaAdminAgentsClient = (): AdminAgentsClient => ({
  // Runtime rollout availability comes from platform.getCapabilities.managedResources.agents.
  // Keep the adapter default closed so direct/partial trees cannot accidentally read Rollout APIs.
  capabilities: { rollouts: false },

  appendVersion: (input) => lambdaClient.admin.agents.appendVersion.mutate(input),
  archive: (input) => lambdaClient.admin.agents.archive.mutate(input),
  cancelRollout: (input) => lambdaClient.admin.agents.rollouts.cancel.mutate(input),
  create: (input) => lambdaClient.admin.agents.create.mutate(input),
  delete: (input) => lambdaClient.admin.agents.delete.mutate(input),
  get: (input) => lambdaClient.admin.agents.get.query(input),
  getRollout: (input) => lambdaClient.admin.agents.rollouts.get.query(input),
  list: (input) => lambdaClient.admin.agents.list.query(input),
  listAssignments: (input) => lambdaClient.admin.agents.assignments.list.query(input),
  listRollouts: (input) => lambdaClient.admin.agents.rollouts.list.query(input),
  listVersions: (input) => lambdaClient.admin.agents.listVersions.query(input),
  previewAssignment: (input) => lambdaClient.admin.agents.assignments.preview.query(input),
  publish: (input) => lambdaClient.admin.agents.publish.mutate(input),
  removeAssignment: (input) => lambdaClient.admin.agents.assignments.remove.mutate(input),
  retryRollout: (input) => lambdaClient.admin.agents.rollouts.retry.mutate(input),
  rollback: (input) => lambdaClient.admin.agents.rollback.mutate(input),
  rollbackRollout: (input) => lambdaClient.admin.agents.rollouts.rollback.mutate(input),
  setDefaultInbox: (input) => lambdaClient.admin.agents.setDefaultInbox.mutate(input),
  startRollout: (input) => lambdaClient.admin.agents.rollouts.start.mutate(input),
  upsertAssignment: (input) => lambdaClient.admin.agents.assignments.upsert.mutate(input),
});

/**
 * PR-050 adapter seam. Production resolves to the real `admin.agents.*` lambda adapter; the
 * mock client is reserved for explicit test injection and never becomes the runtime default.
 */
export const adminAgentsService: AdminAgentsClient = createLambdaAdminAgentsClient();
