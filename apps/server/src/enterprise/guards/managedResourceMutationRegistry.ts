import type { ManagedResourceKind } from '@/const/platform/managedResources';

export type ManagedMutationClassification = 'deny' | 'allow' | 'exempt' | 'input-sensitive';

export interface ManagedResourceMutationDefinition {
  /** `deny` and non-exempt `input-sensitive` entries deny only in enforced mode. */
  classification: ManagedMutationClassification;
  /** Reviewable explanation for why this mutation is guarded or preserved. */
  reason: string;
  resource: ManagedResourceKind;
}

/**
 * Explicit inventory of agentDocument mutations that can reach Skill storage
 * through service/VFS abstractions rather than a directly-scannable SkillModel.
 */
export const AGENT_DOCUMENT_SKILL_MUTATION_RISKS = {
  'agentDocument.cloneDocuments': 'agent-aggregate',
  'agentDocument.convertDocumentToSkill': 'direct-skill',
  'agentDocument.copyDocument': 'document-id',
  'agentDocument.copyDocumentByPath': 'path-pair',
  'agentDocument.createSkillByPath': 'direct-skill',
  'agentDocument.deleteAllDocuments': 'agent-aggregate',
  'agentDocument.deleteDocument': 'filename',
  'agentDocument.deleteDocumentByPath': 'path',
  'agentDocument.deleteDocumentPermanentlyByPath': 'path',
  'agentDocument.deleteSkillByPath': 'direct-skill',
  'agentDocument.mkdirDocumentByPath': 'path',
  'agentDocument.modifyNodes': 'document-id',
  'agentDocument.removeDocument': 'document-id',
  'agentDocument.renameDocument': 'document-id',
  'agentDocument.renameDocumentByPath': 'path-pair',
  'agentDocument.replaceDocumentContent': 'document-id',
  'agentDocument.restoreDocumentFromTrashByPath': 'path',
  'agentDocument.updateLoadRule': 'document-id',
  'agentDocument.updateSkillByPath': 'direct-skill',
  'agentDocument.upsertDocument': 'filename-or-create',
  'agentDocument.writeDocumentByPath': 'path',
} as const;

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

  'agentDocument.associateDocument': {
    classification: 'allow',
    reason: 'Associates an existing document without editing its Skill definition.',
    resource: 'skills',
  },
  'agentDocument.cloneDocuments': {
    classification: 'input-sensitive',
    reason: 'Clones ordinary documents only when the source agent contains no Skill documents.',
    resource: 'skills',
  },
  'agentDocument.convertDocumentToSkill': {
    classification: 'deny',
    reason: 'Converts an ordinary document into a user Skill outside platform publishing.',
    resource: 'skills',
  },
  'agentDocument.copyDocument': {
    classification: 'input-sensitive',
    reason:
      'Copies by document id and must resolve the owned row before excluding Skill documents.',
    resource: 'skills',
  },
  'agentDocument.copyDocumentByPath': {
    classification: 'input-sensitive',
    reason: 'Can copy into or out of the mounted Skill namespace through generic VFS paths.',
    resource: 'skills',
  },
  'agentDocument.createDocument': {
    classification: 'allow',
    reason:
      'Creates an ordinary agent document; hintIsSkill is metadata and not a Skill definition.',
    resource: 'skills',
  },
  'agentDocument.createForTopic': {
    classification: 'allow',
    reason: 'Creates an ordinary topic document and does not write the mounted Skill namespace.',
    resource: 'skills',
  },
  'agentDocument.createSkillByPath': {
    classification: 'deny',
    reason: 'Creates a user Skill definition through the mounted Skill VFS namespace.',
    resource: 'skills',
  },
  'agentDocument.deleteAllDocuments': {
    classification: 'input-sensitive',
    reason: 'Bulk deletion is safe only when the target agent contains no Skill documents.',
    resource: 'skills',
  },
  'agentDocument.deleteDocument': {
    classification: 'input-sensitive',
    reason:
      'Filename lookup can resolve a Skill document and therefore requires owned-row classification.',
    resource: 'skills',
  },
  'agentDocument.deleteDocumentByPath': {
    classification: 'input-sensitive',
    reason: 'Generic VFS deletion can delete a mounted Skill when its path targets that namespace.',
    resource: 'skills',
  },
  'agentDocument.deleteDocumentPermanentlyByPath': {
    classification: 'input-sensitive',
    reason: 'Path-based permanent deletion must not accept a mounted Skill namespace path.',
    resource: 'skills',
  },
  'agentDocument.deleteSkillByPath': {
    classification: 'deny',
    reason: 'Deletes a user Skill definition through the mounted Skill VFS namespace.',
    resource: 'skills',
  },
  'agentDocument.generateSkillMeta': {
    classification: 'allow',
    reason: 'Generates suggested metadata without persisting or changing a Skill definition.',
    resource: 'skills',
  },
  'agentDocument.getOrCreateChatTopic': {
    classification: 'allow',
    reason: 'Creates a document chat topic but does not change the document or Skill definition.',
    resource: 'skills',
  },
  'agentDocument.initializeFromTemplate': {
    classification: 'allow',
    reason: 'Creates ordinary template documents and does not target the mounted Skill namespace.',
    resource: 'skills',
  },
  'agentDocument.mkdirDocumentByPath': {
    classification: 'input-sensitive',
    reason: 'Generic directory creation requires an explicitly ordinary non-Skill VFS path.',
    resource: 'skills',
  },
  'agentDocument.modifyNodes': {
    classification: 'input-sensitive',
    reason: 'Edits content by document id and must resolve the owned row before excluding Skills.',
    resource: 'skills',
  },
  'agentDocument.removeDocument': {
    classification: 'input-sensitive',
    reason: 'Deletes by document id and must resolve the owned row before excluding Skills.',
    resource: 'skills',
  },
  'agentDocument.renameDocument': {
    classification: 'input-sensitive',
    reason: 'Renames by document id and must resolve the owned row before excluding Skills.',
    resource: 'skills',
  },
  'agentDocument.renameDocumentByPath': {
    classification: 'input-sensitive',
    reason: 'Generic VFS rename can move data into or out of the mounted Skill namespace.',
    resource: 'skills',
  },
  'agentDocument.replaceDocumentContent': {
    classification: 'input-sensitive',
    reason:
      'Replaces content by document id and must resolve the owned row before excluding Skills.',
    resource: 'skills',
  },
  'agentDocument.restoreDocumentFromTrashByPath': {
    classification: 'input-sensitive',
    reason: 'Path-based restore must reject mounted Skill namespace paths before VFS dispatch.',
    resource: 'skills',
  },
  'agentDocument.updateLoadRule': {
    classification: 'input-sensitive',
    reason:
      'Updates metadata by document id and must resolve the owned row before excluding Skills.',
    resource: 'skills',
  },
  'agentDocument.updateSkillByPath': {
    classification: 'deny',
    reason: 'Edits a user Skill definition through the mounted Skill VFS namespace.',
    resource: 'skills',
  },
  'agentDocument.upsertDocument': {
    classification: 'input-sensitive',
    reason:
      'Upsert remains ordinary unless its owned filename resolves an existing Skill document.',
    resource: 'skills',
  },
  'agentDocument.writeDocumentByPath': {
    classification: 'input-sensitive',
    reason: 'Generic VFS writes can create or edit a Skill when the path targets its namespace.',
    resource: 'skills',
  },

  'agentGroup.acquireGroupLock': {
    classification: 'allow',
    reason: 'Edit-lock coordination does not change an agent or group definition.',
    resource: 'agents',
  },
  'agentGroup.addAgentsToGroup': {
    classification: 'deny',
    reason: 'Changes agent membership and assignment outside the platform publish flow.',
    resource: 'agents',
  },
  'agentGroup.batchCreateAgentsInGroup': {
    classification: 'deny',
    reason: 'Creates virtual agent definitions outside the platform publish flow.',
    resource: 'agents',
  },
  'agentGroup.createGroup': {
    classification: 'deny',
    reason: 'Creates a group and supervisor agent outside the platform publish flow.',
    resource: 'agents',
  },
  'agentGroup.createGroupWithMembers': {
    classification: 'deny',
    reason: 'Creates group, supervisor and member agent definitions outside platform publishing.',
    resource: 'agents',
  },
  'agentGroup.deleteGroup': {
    classification: 'deny',
    reason: 'Deletes a group and associated agent definitions outside platform publishing.',
    resource: 'agents',
  },
  'agentGroup.duplicateGroup': {
    classification: 'deny',
    reason: 'Duplicates a group and virtual agent definitions outside platform publishing.',
    resource: 'agents',
  },
  'agentGroup.publishGroupToWorkspace': {
    classification: 'deny',
    reason: 'Changes group and agent distribution outside the platform publish flow.',
    resource: 'agents',
  },
  'agentGroup.releaseGroupLock': {
    classification: 'allow',
    reason: 'Edit-lock cleanup does not change an agent or group definition.',
    resource: 'agents',
  },
  'agentGroup.removeAgentsFromGroup': {
    classification: 'deny',
    reason: 'Changes membership and may delete virtual agent definitions.',
    resource: 'agents',
  },
  'agentGroup.transferGroup': {
    classification: 'deny',
    reason: 'Moves a group and its agent assignments between ownership scopes.',
    resource: 'agents',
  },
  'agentGroup.updateAgentInGroup': {
    classification: 'deny',
    reason: 'Changes per-group agent role, order or enabled configuration.',
    resource: 'agents',
  },
  'agentGroup.updateGroup': {
    classification: 'deny',
    reason: 'Edits a group and supervisor configuration outside platform publishing.',
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

  // Enable/disable is a PERSONAL VIEW overlay under managed AI: the user's `ai_models.enabled`
  // flag decides only whether an admin-published model appears in that user's own list and
  // picker. It never publishes, unpublishes, or changes what anyone else sees, and the
  // execution allowlist stays published-only. Denying it made models vanish from the settings
  // page with no way to bring them back. Create/delete/edit stay denied — those would change
  // the catalog itself.
  'aiModel.batchToggleAiModels': {
    classification: 'allow',
    reason: 'Personal visibility overlay: hides or shows published models for this user only.',
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
    classification: 'allow',
    reason: 'Personal visibility overlay: hides or shows a published model for this user only.',
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
    classification: 'deny',
    reason: 'Upserts a complete builtin connector definition outside platform publishing.',
    resource: 'connectors',
  },
  'connector.syncPluginTools': {
    classification: 'deny',
    reason: 'Upserts a complete plugin connector definition outside platform publishing.',
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

  'composio.createConnection': {
    classification: 'input-sensitive',
    reason:
      'Starts an owned personal OAuth binding and materializes only the fixed server Composio catalog.',
    resource: 'connectors',
  },
  'composio.deleteConnection': {
    classification: 'exempt',
    reason: 'Disconnects and deletes an owned per-user OAuth binding and its projection.',
    resource: 'connectors',
  },
  'composio.removeComposioPlugin': {
    classification: 'deny',
    reason: 'Deletes a connector definition without the narrow remote-binding disconnect contract.',
    resource: 'connectors',
  },
  'composio.updateComposioPlugin': {
    classification: 'input-sensitive',
    reason:
      'Synchronizes an owned binding from server-confirmed ACTIVE state and trusted Composio tools.',
    resource: 'connectors',
  },

  'home.updateAgentSessionGroupId': {
    classification: 'deny',
    reason: 'Changes agent ownership grouping outside the platform publish flow.',
    resource: 'agents',
  },

  'oauthDeviceFlow.initiateDeviceCode': {
    classification: 'exempt',
    reason: 'Starts a fixed provider per-user OAuth flow without writing provider definition.',
    resource: 'aiProviders',
  },
  'oauthDeviceFlow.pollAuthStatus': {
    classification: 'deny',
    reason: 'Writes OAuth credentials into the legacy user Provider configuration.',
    resource: 'aiProviders',
  },
  'oauthDeviceFlow.revokeAuth': {
    classification: 'deny',
    reason: 'Mutates OAuth credentials in the legacy user Provider configuration.',
    resource: 'aiProviders',
  },
} as const satisfies Record<string, ManagedResourceMutationDefinition>;

export type ManagedResourceMutationProcedure = keyof typeof MANAGED_RESOURCE_MUTATION_REGISTRY;

export const getManagedResourceMutationDefinition = (
  procedure: ManagedResourceMutationProcedure,
): ManagedResourceMutationDefinition => MANAGED_RESOURCE_MUTATION_REGISTRY[procedure];
