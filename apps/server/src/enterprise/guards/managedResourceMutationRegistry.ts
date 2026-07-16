import type { ManagedResourceKind } from '@/const/platform/managedResources';

export type ManagedMutationClassification = 'deny' | 'allow' | 'exempt';

export interface ManagedResourceMutationDefinition {
  /** `deny` means deny only when the effective policy mode is enforced. */
  classification: ManagedMutationClassification;
  /** Reviewable explanation for why this mutation is guarded or preserved. */
  reason: string;
  resource: ManagedResourceKind;
}

/**
 * Exhaustive registry for legacy mutations covered by M06.
 *
 * Every mutation in the five source routers must appear here and must also wire
 * `withManagedResourceGuard` at its procedure. The source coverage test fails
 * when upstream adds or renames a mutation without an explicit classification.
 */
export const MANAGED_RESOURCE_MUTATION_REGISTRY = {
  'agent.acquireAgentLock': {
    classification: 'allow',
    reason: 'Edit-lock coordination does not change the agent definition.',
    resource: 'agents',
  },
  'agent.createAgent': {
    classification: 'deny',
    reason: 'Creates a user-owned agent definition outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.createAgentFiles': {
    classification: 'deny',
    reason: 'Changes an agent definition by attaching files.',
    resource: 'agents',
  },
  'agent.createAgentKnowledgeBase': {
    classification: 'deny',
    reason: 'Changes an agent definition by attaching a knowledge base.',
    resource: 'agents',
  },
  'agent.createAgentOnly': {
    classification: 'deny',
    reason: 'Creates a group agent outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.deleteAgentFile': {
    classification: 'deny',
    reason: 'Changes an agent definition by detaching a file.',
    resource: 'agents',
  },
  'agent.deleteAgentKnowledgeBase': {
    classification: 'deny',
    reason: 'Changes an agent definition by detaching a knowledge base.',
    resource: 'agents',
  },
  'agent.duplicateAgent': {
    classification: 'deny',
    reason: 'Creates a copied agent outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.publishAgentToWorkspace': {
    classification: 'deny',
    reason: 'Changes agent distribution visibility outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.releaseAgentLock': {
    classification: 'allow',
    reason: 'Edit-lock cleanup does not change the agent definition.',
    resource: 'agents',
  },
  'agent.removeAgent': {
    classification: 'deny',
    reason: 'Deletes an agent definition outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.setAgentVisibility': {
    classification: 'deny',
    reason: 'Changes agent distribution visibility outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.toggleFile': {
    classification: 'deny',
    reason: 'Changes enabled file configuration on an agent.',
    resource: 'agents',
  },
  'agent.toggleKnowledgeBase': {
    classification: 'deny',
    reason: 'Changes enabled knowledge-base configuration on an agent.',
    resource: 'agents',
  },
  'agent.transferAgent': {
    classification: 'deny',
    reason: 'Moves an agent definition between ownership scopes.',
    resource: 'agents',
  },
  'agent.updateAgentConfig': {
    classification: 'deny',
    reason: 'Edits an agent definition outside the platform publish flow.',
    resource: 'agents',
  },
  'agent.updateAgentPinned': {
    classification: 'exempt',
    reason: 'Pinning is a per-user presentation preference, not an agent definition edit.',
    resource: 'agents',
  },

  'agentSkills.create': {
    classification: 'deny',
    reason: 'Creates a user skill outside the platform catalog publish flow.',
    resource: 'skills',
  },
  'agentSkills.delete': {
    classification: 'deny',
    reason: 'Deletes a user skill outside the platform catalog publish flow.',
    resource: 'skills',
  },
  'agentSkills.importFromGitHub': {
    classification: 'deny',
    reason: 'Imports a skill definition outside the platform validation flow.',
    resource: 'skills',
  },
  'agentSkills.importFromMarket': {
    classification: 'deny',
    reason: 'Imports a skill definition outside the platform validation flow.',
    resource: 'skills',
  },
  'agentSkills.importFromUrl': {
    classification: 'deny',
    reason: 'Imports a skill definition outside the platform validation flow.',
    resource: 'skills',
  },
  'agentSkills.importFromZip': {
    classification: 'deny',
    reason: 'Imports a skill definition outside the platform validation flow.',
    resource: 'skills',
  },
  'agentSkills.update': {
    classification: 'deny',
    reason: 'Edits a skill definition outside the platform catalog publish flow.',
    resource: 'skills',
  },

  'aiModel.batchToggleAiModels': {
    classification: 'deny',
    reason: 'Changes model availability outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.batchUpdateAiModels': {
    classification: 'deny',
    reason: 'Bulk-edits model definitions outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.clearModelsByProvider': {
    classification: 'deny',
    reason: 'Deletes model definitions outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.clearRemoteModels': {
    classification: 'deny',
    reason: 'Deletes remotely discovered model definitions.',
    resource: 'aiModels',
  },
  'aiModel.createAiModel': {
    classification: 'deny',
    reason: 'Creates a model definition outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.removeAiModel': {
    classification: 'deny',
    reason: 'Deletes a model definition outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.toggleModelEnabled': {
    classification: 'deny',
    reason: 'Changes model availability outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.updateAiModel': {
    classification: 'deny',
    reason: 'Edits a model definition outside the platform catalog publish flow.',
    resource: 'aiModels',
  },
  'aiModel.updateAiModelOrder': {
    classification: 'deny',
    reason: 'Changes model catalog ordering outside the platform publish flow.',
    resource: 'aiModels',
  },

  'aiProvider.checkProviderConnectivity': {
    classification: 'allow',
    reason: 'Connectivity checks use an existing provider and do not persist configuration.',
    resource: 'aiProviders',
  },
  'aiProvider.createAiProvider': {
    classification: 'deny',
    reason: 'Creates a provider definition outside the platform publish flow.',
    resource: 'aiProviders',
  },
  'aiProvider.removeAiProvider': {
    classification: 'deny',
    reason: 'Deletes a provider definition outside the platform publish flow.',
    resource: 'aiProviders',
  },
  'aiProvider.toggleProviderEnabled': {
    classification: 'deny',
    reason: 'Changes provider availability outside the platform publish flow.',
    resource: 'aiProviders',
  },
  'aiProvider.updateAiProvider': {
    classification: 'deny',
    reason: 'Edits provider metadata outside the platform publish flow.',
    resource: 'aiProviders',
  },
  'aiProvider.updateAiProviderConfig': {
    classification: 'deny',
    reason: 'Edits provider credentials or configuration outside the platform publish flow.',
    resource: 'aiProviders',
  },
  'aiProvider.updateAiProviderOrder': {
    classification: 'deny',
    reason: 'Changes provider catalog ordering outside the platform publish flow.',
    resource: 'aiProviders',
  },

  'connector.callTool': {
    classification: 'allow',
    reason: 'Executes an existing connector tool; runtime use must remain available.',
    resource: 'connectors',
  },
  'connector.create': {
    classification: 'deny',
    reason: 'Creates a connector definition outside the platform publish flow.',
    resource: 'connectors',
  },
  'connector.delete': {
    classification: 'deny',
    reason:
      'Deletes the entire user connector definition; personal disconnect uses update isEnabled=false.',
    resource: 'connectors',
  },
  'connector.resetPermissions': {
    classification: 'exempt',
    reason: 'Resets per-user tool permission choices without editing the catalog definition.',
    resource: 'connectors',
  },
  'connector.startOAuth': {
    classification: 'exempt',
    reason: 'Starts per-user OAuth authorization, which remains available when managed.',
    resource: 'connectors',
  },
  'connector.syncBuiltinTool': {
    classification: 'allow',
    reason: 'Materializes derived tool metadata for runtime use of a builtin connector.',
    resource: 'connectors',
  },
  'connector.syncPluginTools': {
    classification: 'allow',
    reason: 'Materializes derived tool metadata for runtime use of an installed plugin.',
    resource: 'connectors',
  },
  'connector.syncTools': {
    classification: 'allow',
    reason: 'Refreshes derived remote tool metadata needed for connector runtime use.',
    resource: 'connectors',
  },
  'connector.syncToolsFromClient': {
    classification: 'deny',
    reason: 'Accepts arbitrary client tool definitions and upserts a connector catalog entry.',
    resource: 'connectors',
  },
  'connector.update': {
    classification: 'deny',
    reason:
      'Edits a connector definition or credential; exact isEnabled=false disconnect is exempted.',
    resource: 'connectors',
  },
  'connector.updateToolPermission': {
    classification: 'exempt',
    reason: 'Changes a per-user tool permission choice, which remains available when managed.',
    resource: 'connectors',
  },
} as const satisfies Record<string, ManagedResourceMutationDefinition>;

export type ManagedResourceMutationProcedure = keyof typeof MANAGED_RESOURCE_MUTATION_REGISTRY;

export const getManagedResourceMutationDefinition = (
  procedure: ManagedResourceMutationProcedure,
): ManagedResourceMutationDefinition => MANAGED_RESOURCE_MUTATION_REGISTRY[procedure];
