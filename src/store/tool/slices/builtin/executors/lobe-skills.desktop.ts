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

import { filterBuiltinSkills } from '@/helpers/skillFilters';
import { desktopSkillRuntimeService } from '@/services/electron/desktopSkillRuntime';
import { localFileService } from '@/services/electron/localFileService';
import { createClientSkillRuntimeService } from '@/services/platformSkillRuntime';

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
        );
        try {
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
        } finally {
          await desktopSkillRuntimeService.cleanupExecutionWorkspace(workspace);
        }
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
