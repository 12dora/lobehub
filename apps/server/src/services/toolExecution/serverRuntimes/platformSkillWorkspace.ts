import { LocalSystemApiName, LocalSystemIdentifier } from '@lobechat/builtin-tool-local-system';
import type { CommandResult, ExecScriptActivatedSkill } from '@lobechat/builtin-tool-skills';
import type { SkillRuntimeService } from '@lobechat/builtin-tool-skills/executionRuntime';
import type { PlatformSkillOperationSnapshot } from '@lobechat/context-engine';
import { validateInlineSkillOperationPayloads } from '@lobechat/device-control';

import type { LobeChatDatabase } from '@/database/type';
import {
  cleanupSandboxSkillWorkspace,
  createSandboxSkillWorkspaceRoot,
  getBuiltinSkillDefinitions,
  PlatformSkillOperationResolver,
  SkillCatalogReadService,
  sweepExpiredSandboxSkillWorkspaces,
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
      agentId?: string;
      executionTimeoutMs?: number;
      operationId?: string;
      serverDB: LobeChatDatabase;
      snapshot: PlatformSkillOperationSnapshot;
      topicId?: string;
      userId: string;
      workspaceId?: string;
    },
  ) {
    if (
      !options.agentId ||
      options.snapshot.agentId !== options.agentId ||
      !options.operationId ||
      options.snapshot.operationId !== options.operationId
    ) {
      throw new Error('Managed Skill operation context does not match its signed snapshot');
    }
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
    const resolved = [];
    for (const activated of activatedSkills) {
      const ref = this.refsByKey.get(activated.name);
      if (!ref)
        throw new Error(`Managed Skill is not in the operation snapshot: ${activated.name}`);
      const skill = await this.catalog.resolvePinnedForExecution(ref);
      if (!skill) throw new Error(`Managed Skill could not be resolved exactly: ${ref.skillKey}`);
      resolved.push({ ref, skill });
    }
    const payloads = validateInlineSkillOperationPayloads(
      resolved.map(({ skill }) => ({ resources: skill.resources, skillContent: skill.content })),
    );
    return resolved.map((item, index) => ({ ...item, resources: payloads[index].resources }));
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
    // A random suffix makes concurrent tool calls in one operation independent: one call's finally
    // cleanup can never delete another call's files, so no reference counting is required.
    const { auditId, root } = createSandboxSkillWorkspaceRoot(this.options.operationId!);
    let runDir: string | undefined;
    try {
      await sweepExpiredSandboxSkillWorkspaces(sandbox);
      const init = await sandbox.callTool('runCommand', {
        command: `umask 077 && mkdir -p ${shellQuote(root)} && [ ! -L ${shellQuote(root)} ] && [ "$(stat -c %u ${shellQuote(root)})" = "$(id -u)" ] && chmod 700 ${shellQuote(root)}`,
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
          command: `[ ! -L ${shellQuote(root)} ] && [ "$(stat -c %u ${shellQuote(root)})" = "$(id -u)" ] && ! find -P ${shellQuote(skillDir)} -type l -print -quit | grep -q . && find -P ${shellQuote(skillDir)} -type d -exec chmod 700 {} + && find -P ${shellQuote(skillDir)} -type f -exec chmod 600 {} +`,
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
      await cleanupSandboxSkillWorkspace({ auditId, root, sandbox });
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
