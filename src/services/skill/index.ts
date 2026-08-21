import type {
  PlatformSkillOperationSnapshot,
  PlatformSkillPinnedRef,
} from '@lobechat/context-engine';
import type {
  CreateSkillInput,
  ImportGitHubInput,
  ImportUrlInput,
  ImportZipInput,
  SkillImportResult,
  SkillItem,
  SkillListItem,
  SkillResourceContent,
  SkillResourceTreeNode,
  SkillSource,
  UpdateSkillInput,
} from '@lobechat/types';

import { lambdaClient } from '@/libs/trpc/client';

/**
 * Per-request options forwarded to tRPC. `signal` lets a caller that owns an
 * abortable unit of work (e.g. a chat operation being stopped mid-send) tear
 * the request down instead of waiting for a response nobody will use.
 */
interface SkillRequestOptions {
  signal?: AbortSignal;
}

class AgentSkillService {
  // ===== Create =====

  async createSkill(params: CreateSkillInput): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.create.mutate(params);
  }

  // ===== Import =====

  async importFromGitHub(params: ImportGitHubInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromGitHub.mutate(params);
  }

  async importFromUrl(params: ImportUrlInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromUrl.mutate(params);
  }

  async importFromZip(params: ImportZipInput): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromZip.mutate(params);
  }

  async importFromMarket(identifier: string): Promise<SkillImportResult | undefined> {
    return lambdaClient.agentSkills.importFromMarket.mutate({ identifier });
  }

  // ===== Query =====

  async getById(id: string, options?: SkillRequestOptions): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getById.query({ id }, options);
  }

  async getZipUrl(id: string): Promise<{ name: string; url: string | null }> {
    return lambdaClient.agentSkills.getByIdWithZipUrl.query({ id });
  }

  async getByIdentifier(
    identifier: string,
    options?: SkillRequestOptions,
  ): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getByIdentifier.query({ identifier }, options);
  }

  async getByName(name: string): Promise<SkillItem | undefined> {
    return lambdaClient.agentSkills.getByName.query({ name });
  }

  async list(source?: SkillSource): Promise<{ data: SkillListItem[]; total: number }> {
    return lambdaClient.agentSkills.list.query(source ? { source } : undefined);
  }

  async search(query: string): Promise<{ data: SkillListItem[]; total: number }> {
    return lambdaClient.agentSkills.search.query({ query });
  }

  // ===== Resources =====

  async listResources(id: string, includeContent?: boolean): Promise<SkillResourceTreeNode[]> {
    return lambdaClient.agentSkills.listResources.query({ id, includeContent });
  }

  async readResource(id: string, path: string): Promise<SkillResourceContent> {
    return lambdaClient.agentSkills.readResource.query({ id, path });
  }

  async beginPlatformSkillOperation(
    snapshot: Pick<PlatformSkillOperationSnapshot, 'agentId' | 'operationId' | 'refs' | 'revision'>,
    options?: SkillRequestOptions,
  ) {
    if (!snapshot.agentId || !snapshot.operationId) {
      throw new Error('Platform Skill operation identity is required');
    }
    return lambdaClient.platform.skills.beginOperation.mutate(
      {
        agentId: snapshot.agentId,
        operationId: snapshot.operationId,
        refs: snapshot.refs,
        revision: snapshot.revision,
      },
      options,
    );
  }

  async resolvePlatformPinned(
    ref: PlatformSkillPinnedRef,
    operation?: PlatformSkillOperationSnapshot,
    options?: SkillRequestOptions,
  ) {
    return lambdaClient.agentSkills.resolvePlatformPinned.query(
      {
        operation:
          operation?.agentId && operation.operationId && operation.proof
            ? {
                agentId: operation.agentId,
                operationId: operation.operationId,
                proof: operation.proof,
                refs: operation.refs,
                revision: operation.revision,
              }
            : undefined,
        ref,
      },
      options,
    );
  }

  // ===== Update =====

  async updateSkill(params: UpdateSkillInput): Promise<SkillItem> {
    return lambdaClient.agentSkills.update.mutate({
      content: params.content,
      id: params.id,
      manifest: params.manifest,
    });
  }

  // ===== Delete =====

  async deleteSkill(id: string): Promise<{ success: boolean }> {
    return lambdaClient.agentSkills.delete.mutate({ id });
  }
}

export const agentSkillService = new AgentSkillService();
