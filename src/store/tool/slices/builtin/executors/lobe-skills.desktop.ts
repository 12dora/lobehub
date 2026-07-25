/**
 * Lobe Skills Executor (Desktop)
 *
 * Desktop version: all commands run locally via localFileService.
 * No cloud sandbox, no exportFile.
 */
import { builtinSkills } from '@lobechat/builtin-skills';
import { SkillsExecutionRuntime } from '@lobechat/builtin-tool-skills/executionRuntime';
import { SkillsExecutor } from '@lobechat/builtin-tool-skills/executor';
import type { BuiltinToolContext } from '@lobechat/types';
import debug from 'debug';

import { filterBuiltinSkills } from '@/helpers/skillFilters';
import { desktopSkillRuntimeService } from '@/services/electron/desktopSkillRuntime';
import { localFileService } from '@/services/electron/localFileService';
import { createClientSkillRuntimeService } from '@/services/platformSkillRuntime';

const log = debug('lobe-desktop:skills-executor');

/**
 * Run a primary command and always attempt workspace cleanup without letting
 * cleanup failure replace the command's return value or thrown error.
 * Exported for unit tests.
 */
export const withDesktopSkillWorkspaceCleanup = async <T>(
  cleanup: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> => {
  let result: T | undefined;
  let commandError: unknown;
  try {
    result = await run();
  } catch (error) {
    commandError = error;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      log('workspace cleanup failed (primary outcome preserved): %O', cleanupError);
      try {
        await cleanup();
      } catch (retryError) {
        log('workspace cleanup retry failed: %O', retryError);
      }
    }
  }
  if (commandError !== undefined) throw commandError;
  return result as T;
};

const createRuntime = (ctx: BuiltinToolContext) =>
  new SkillsExecutionRuntime({
    builtinSkills: ctx.platformSkillSnapshot ? [] : filterBuiltinSkills(builtinSkills),
    service: {
      ...createClientSkillRuntimeService(ctx.platformSkillSnapshot),
      execScript: async (command, options) => {
        const workspace = await desktopSkillRuntimeService.prepareExecutionWorkspace(
          options.activatedSkills,
          ctx.platformSkillSnapshot,
          ctx.operationId,
          ctx.agentId,
        );
        return withDesktopSkillWorkspaceCleanup(
          () => desktopSkillRuntimeService.cleanupExecutionWorkspace(workspace),
          async () => {
            const result = await localFileService.runCommand({
              command,
              cwd: workspace.cwd,
              description: options.description,
              timeout: undefined,
            });
            return {
              exitCode: result.exit_code ?? 1,
              output: result.stdout || result.output || '',
              stderr: result.stderr,
              success: result.success,
            };
          },
        );
      },
      readResource: async (id, path) => {
        const resource = await createClientSkillRuntimeService(
          ctx.platformSkillSnapshot,
        ).readResource(id, path);
        const fullPath = await desktopSkillRuntimeService.resolveReferenceFullPath({
          path,
          platformSkillSnapshot: ctx.platformSkillSnapshot,
          skillId: id,
        });

        return {
          ...resource,
          fullPath,
        };
      },
    },
  });

export const skillsExecutor = new SkillsExecutor(createRuntime);
