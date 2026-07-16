import { createHash, randomUUID } from 'node:crypto';

import { LocalSystemApiName, LocalSystemIdentifier } from '@lobechat/builtin-tool-local-system';
import type { CommandResult, ExecScriptActivatedSkill } from '@lobechat/builtin-tool-skills';
import type { SkillRuntimeService } from '@lobechat/builtin-tool-skills/executionRuntime';
import type { PlatformSkillOperationSnapshot } from '@lobechat/context-engine';
import {
  MAX_INLINE_SKILL_FILES,
  MAX_INLINE_SKILL_TOTAL_BYTES,
  validateInlineSkillResources,
} from '@lobechat/device-control';

import type { LobeChatDatabase } from '@/database/type';
import {
  getBuiltinSkillDefinitions,
  PlatformSkillOperationResolver,
  SkillCatalogReadService,
} from '@/server/enterprise/services/skillCatalog';
import { deviceGateway } from '@/server/services/deviceGateway';
import { MarketService } from '@/server/services/market';
import { createSandboxService, normalizeSandboxCommandResult } from '@/server/services/sandbox';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export class ManagedSkillServerRuntimeService implements SkillRuntimeService {
  private readonly catalog: SkillCatalogReadService;
  private readonly resolver: PlatformSkillOperationResolver;
  private readonly refsByKey: Map<string, { checksum: string; skillKey: string; version: string }>;

  constructor(
    private readonly options: {
      activeDeviceId?: string;
      executionTimeoutMs?: number;
      operationId?: string;
      serverDB: LobeChatDatabase;
      snapshot: PlatformSkillOperationSnapshot;
      topicId?: string;
      userId: string;
      workspaceId?: string;
    },
  ) {
    this.catalog = new SkillCatalogReadService(options.serverDB, {
      builtinSkills: getBuiltinSkillDefinitions(),
    });
    this.resolver = new PlatformSkillOperationResolver(options.snapshot, this.catalog);
    this.refsByKey = new Map(options.snapshot.refs.map((ref) => [ref.skillKey, ref]));
  }

  findAll = () => this.resolver.findAll();
  findById = (id: string) => this.resolver.findById(id);
  findByName = (name: string) => this.resolver.findByName(name);
  readResource = (id: string, path: string) => this.resolver.readResource(id, path);

  private resolveActivated = async (activatedSkills?: ExecScriptActivatedSkill[]) => {
    if (!activatedSkills?.length) {
      throw new Error('Managed Skill execScript requires an activated operation Skill');
    }
    if (activatedSkills.length > MAX_INLINE_SKILL_FILES) {
      throw new Error('Managed Skill activation count exceeds the workspace limit');
    }
    const resolved = [];
    let totalFiles = 0;
    let totalBytes = 0;
    for (const activated of activatedSkills) {
      const ref = this.refsByKey.get(activated.name);
      if (!ref)
        throw new Error(`Managed Skill is not in the operation snapshot: ${activated.name}`);
      const skill = await this.catalog.resolvePinnedForExecution(ref);
      if (!skill) throw new Error(`Managed Skill could not be resolved exactly: ${ref.skillKey}`);
      const resources = validateInlineSkillResources(skill.resources);
      totalFiles += resources.length + 1;
      totalBytes +=
        new TextEncoder().encode(skill.content).byteLength +
        resources.reduce((sum, resource) => sum + resource.sizeBytes, 0);
      if (totalFiles > MAX_INLINE_SKILL_FILES || totalBytes > MAX_INLINE_SKILL_TOTAL_BYTES) {
        throw new Error('Managed Skill operation workspace exceeds its aggregate limit');
      }
      resolved.push({ ref, resources, skill });
    }
    return resolved;
  };

  private sandboxService = () => {
    if (!this.options.topicId) throw new Error('topicId is required for managed Skill execution');
    return createSandboxService({
      marketService: new MarketService({ userInfo: { userId: this.options.userId } }),
      topicId: this.options.topicId,
      userId: this.options.userId,
    });
  };

  runCommand = async ({ command }: { command: string }): Promise<CommandResult> => {
    if (this.options.activeDeviceId) {
      return {
        executionEnv: 'device',
        exitCode: 1,
        output: '',
        stderr: 'Use execScript for managed Skill commands on a routed device.',
        success: false,
      };
    }
    const response = await this.sandboxService().callTool('runCommand', { command });
    if (!response.success) {
      return {
        executionEnv: 'sandbox',
        exitCode: 1,
        output: '',
        stderr: response.error?.message || 'Command execution failed',
        success: false,
      };
    }
    return { ...normalizeSandboxCommandResult(response), executionEnv: 'sandbox' };
  };

  execScript = async (
    command: string,
    options: { activatedSkills?: ExecScriptActivatedSkill[]; description: string },
  ): Promise<CommandResult> => {
    if (!this.options.operationId) {
      return { exitCode: 1, output: '', stderr: 'operationId is required', success: false };
    }
    const skills = await this.resolveActivated(options.activatedSkills);
    return this.options.activeDeviceId
      ? this.execScriptOnDevice(command, skills)
      : this.execScriptInSandbox(command, skills);
  };

  private execScriptInSandbox = async (
    command: string,
    skills: Awaited<ReturnType<ManagedSkillServerRuntimeService['resolveActivated']>>,
  ): Promise<CommandResult> => {
    const sandbox = this.sandboxService();
    const operationHash = createHash('sha256')
      .update(this.options.operationId!)
      .digest('hex')
      .slice(0, 24);
    // A random suffix makes concurrent tool calls in one operation independent: one call's finally
    // cleanup can never delete another call's files, so no reference counting is required.
    const root = `/tmp/lobe-managed-skills/${operationHash}-${randomUUID()}`;
    let runDir: string | undefined;
    try {
      const init = await sandbox.callTool('runCommand', {
        command: `umask 077 && mkdir -p ${shellQuote(root)} && chmod 700 ${shellQuote(root)}`,
      });
      if (!init.success) throw new Error(init.error?.message || 'Failed to create Skill workspace');

      for (const { ref, resources, skill } of skills) {
        const skillDir = `${root}/${ref.checksum}`;
        runDir = skillDir;
        for (const resource of [{ content: skill.content, path: 'SKILL.md' }, ...resources]) {
          const write = await sandbox.callTool('writeFile', {
            content: resource.content,
            createDirectories: true,
            path: `${skillDir}/${resource.path}`,
          });
          if (!write.success) {
            throw new Error(write.error?.message || `Failed to materialize ${resource.path}`);
          }
        }
        const protect = await sandbox.callTool('runCommand', {
          command: `find ${shellQuote(skillDir)} -type d -exec chmod 700 {} + && find ${shellQuote(skillDir)} -type f -exec chmod 600 {} +`,
        });
        if (!protect.success)
          throw new Error(protect.error?.message || 'Failed to protect workspace');
      }

      const response = await sandbox.callTool('runCommand', {
        command: `cd ${shellQuote(runDir!)} && ${command}`,
      });
      if (!response.success) throw new Error(response.error?.message || 'Command execution failed');
      return { ...normalizeSandboxCommandResult(response), executionEnv: 'sandbox' };
    } catch (error) {
      return {
        executionEnv: 'sandbox',
        exitCode: 1,
        output: '',
        stderr: (error as Error).message,
        success: false,
      };
    } finally {
      await sandbox
        .callTool('runCommand', { command: `rm -rf ${shellQuote(root)}` })
        .catch(() => {});
    }
  };

  private execScriptOnDevice = async (
    command: string,
    skills: Awaited<ReturnType<ManagedSkillServerRuntimeService['resolveActivated']>>,
  ): Promise<CommandResult> => {
    const deviceId = this.options.activeDeviceId!;
    const workspacePrincipalId = this.options.workspaceId;
    const workspaceIds: string[] = [];
    let cwd: string | undefined;
    try {
      for (const { ref, resources, skill } of skills) {
        const prepared = await deviceGateway.prepareInlineSkillWorkspace({
          checksum: ref.checksum,
          deviceId,
          operationId: this.options.operationId!,
          resources,
          skillContent: skill.content,
          skillKey: ref.skillKey,
          userId: this.options.userId,
          version: ref.version,
          workspaceId: workspacePrincipalId,
        });
        if (!prepared.success || !prepared.workspaceDir || !prepared.workspaceId) {
          throw new Error(prepared.error || `Failed to materialize managed Skill: ${ref.skillKey}`);
        }
        cwd = prepared.workspaceDir;
        workspaceIds.push(prepared.workspaceId);
      }
      const response = await deviceGateway.executeToolCall(
        {
          deviceId,
          operationId: this.options.operationId,
          userId: this.options.userId,
          workspaceId: workspacePrincipalId,
        },
        {
          apiName: LocalSystemApiName.runCommand,
          arguments: JSON.stringify({ command, cwd }),
          identifier: LocalSystemIdentifier,
        },
        this.options.executionTimeoutMs,
      );
      const state = (response.state ?? {}) as {
        exitCode?: number;
        stderr?: string;
        stdout?: string;
        success?: boolean;
      };
      const success = response.success && state.success !== false && state.exitCode === 0;
      return {
        executionEnv: 'device',
        exitCode: state.exitCode ?? (success ? 0 : 1),
        output: state.stdout ?? response.content ?? '',
        stderr: state.stderr ?? response.error,
        success,
      };
    } catch (error) {
      return {
        executionEnv: 'device',
        exitCode: 1,
        output: '',
        stderr: (error as Error).message,
        success: false,
      };
    } finally {
      await Promise.all(
        workspaceIds.map((workspaceId) =>
          deviceGateway.cleanupInlineSkillWorkspace({
            deviceId,
            userId: this.options.userId,
            workspaceId,
            workspacePrincipalId,
          }),
        ),
      );
    }
  };
}
