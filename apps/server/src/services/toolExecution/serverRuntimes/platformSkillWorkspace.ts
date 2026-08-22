import { LocalSystemApiName, LocalSystemIdentifier } from '@lobechat/builtin-tool-local-system';
import type { CommandResult, ExecScriptActivatedSkill } from '@lobechat/builtin-tool-skills';
import type { SkillRuntimeService } from '@lobechat/builtin-tool-skills/executionRuntime';
import type { PlatformSkillOperationSnapshot } from '@lobechat/context-engine';
import { validateInlineSkillOperationPayloads } from '@lobechat/device-control';
import debug from 'debug';

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
import {
  createSandboxService,
  isInterruptedSandboxResult,
  normalizeSandboxCommandResult,
} from '@/server/services/sandbox';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const log = debug('lobe-server:managed-skill-runtime');
const MANAGED_SKILL_RUN_FAILED =
  'This Skill couldn’t run. Start a new run and try again. If the problem continues, contact your administrator.';
const MANAGED_SKILL_UNAVAILABLE =
  'This Skill is no longer available. Start a new run or ask your administrator to republish it.';

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
      log('operation context rejected reason=snapshot_mismatch');
      throw new Error(MANAGED_SKILL_RUN_FAILED);
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
      log('activated Skill resolution rejected reason=missing_activation');
      throw new Error(MANAGED_SKILL_RUN_FAILED);
    }
    const resolved = [];
    for (const activated of activatedSkills) {
      const ref = this.refsByKey.get(activated.name);
      if (!ref) {
        log(
          'activated Skill resolution rejected reason=reference_missing skill=%s',
          activated.name,
        );
        throw new Error(MANAGED_SKILL_UNAVAILABLE);
      }
      const skill = await this.catalog.resolvePinnedForExecution(ref);
      if (!skill) {
        log('activated Skill resolution rejected reason=revision_missing skill=%s', ref.skillKey);
        throw new Error(MANAGED_SKILL_UNAVAILABLE);
      }
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
    if (!response.success && !isInterruptedSandboxResult(response)) {
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
      log('execScript rejected reason=operation_missing');
      return { exitCode: 1, output: '', stderr: MANAGED_SKILL_RUN_FAILED, success: false };
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
      if (!response.success && !isInterruptedSandboxResult(response)) {
        throw new Error(response.error?.message || 'Command execution failed');
      }
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
