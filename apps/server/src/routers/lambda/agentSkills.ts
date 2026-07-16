import type { SkillManifest } from '@lobechat/types';
import { skillManifestSchema } from '@lobechat/types';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { withScopedPermission } from '@/business/server/trpc-middlewares/rbacPermission';
import { wsCompatProcedure } from '@/business/server/trpc-middlewares/workspaceAuth';
import { AgentSkillModel } from '@/database/models/agentSkill';
import { FileModel } from '@/database/models/file';
import { router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { platformSkillPinnedRefSchema } from '@/server/enterprise/contracts/skillCatalog';
import { parseEnterpriseFeatureFlags } from '@/server/enterprise/featureFlags';
import { withManagedResourceGuard } from '@/server/enterprise/guards/managedResource';
import {
  getBuiltinSkillDefinitions,
  resolvePlatformSkillRuntimeSnapshot,
  SkillCatalogReadService,
} from '@/server/enterprise/services/skillCatalog';
import { FileService } from '@/server/services/file';
import { MarketService } from '@/server/services/market';
import {
  SkillImporter,
  SkillImportError,
  SkillResourceError,
  SkillResourceService,
} from '@/server/services/skill';

// ===== Error Handling =====

const skillImportErrorToTRPCCode = (
  code: SkillImportError['code'],
): 'CONFLICT' | 'BAD_REQUEST' | 'NOT_FOUND' | 'BAD_GATEWAY' => {
  switch (code) {
    case 'CONFLICT': {
      return 'CONFLICT';
    }

    case 'NOT_FOUND':
    case 'FILE_NOT_FOUND': {
      return 'NOT_FOUND';
    }

    case 'DOWNLOAD_FAILED': {
      return 'BAD_GATEWAY';
    }

    default: {
      return 'BAD_REQUEST';
    }
  }
};

const handleSkillImportError = (error: unknown): never => {
  if (error instanceof SkillImportError) {
    throw new TRPCError({
      code: skillImportErrorToTRPCCode(error.code),
      message: error.message,
    });
  }
  throw error;
};

// ===== Procedures with Context =====

// Reads: workspace-aware, any member can read. In personal mode the request
// runs without workspace context (legacy behavior preserved).
const skillProcedure = wsCompatProcedure.use(serverDatabase).use(async (opts) => {
  const { ctx } = opts;
  const workspaceId = ctx.workspaceId ?? undefined;
  const skillModel = new AgentSkillModel(ctx.serverDB, ctx.userId, workspaceId);

  return opts.next({
    ctx: {
      fileModel: new FileModel(ctx.serverDB, ctx.userId, workspaceId),
      fileService: new FileService(ctx.serverDB, ctx.userId, workspaceId),
      marketService: new MarketService({ userInfo: { userId: ctx.userId } }),
      skillImporter: new SkillImporter(ctx.serverDB, ctx.userId, workspaceId),
      skillModel,
    },
  });
});

// Writes: workspace mode goes through RBAC (`agent:update:all | :owner`),
// gating viewers out while letting members and owners install/edit skills.
// Personal mode is unrestricted (middleware passes through when no
// workspaceId). Replaces the legacy `requireWorkspaceRoleWhenScoped('owner')`
// which was overly restrictive (member should be able to manage skills they
// own, per the role-permission matrix in @lobechat/const/rbac).
const skillWriteProcedure = skillProcedure.use(withScopedPermission('agent:update'));

const skillResourceProcedure = skillProcedure.use(async (opts) => {
  const { ctx } = opts;

  return opts.next({
    ctx: {
      // workspace-audit: intentionally personal-scoped (no workspaceId). This service
      // only reads skill resource files by content hash (global, deduplicated files),
      // never runs a per-workspace row query, so workspace scoping is a no-op here.
      skillResourceService: new SkillResourceService(ctx.serverDB, ctx.userId),
    },
  });
});

// ===== Input Schemas =====

const createSkillSchema = z.object({
  content: z.string(),
  description: z.string().min(1),
  identifier: z.string().optional(),
  name: z.string().min(1),
});

const updateSkillSchema = z.object({
  content: z.string().optional(),
  id: z.string(),
  // All metadata should be passed through manifest
  manifest: skillManifestSchema.partial().optional(),
});

const platformSkillExecutionProjectionSchema = z
  .object({
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    content: z.string(),
    description: z.string().nullable(),
    identifier: z.string(),
    name: z.string(),
    resources: z.array(
      z
        .object({
          checksum: z.string().regex(/^[a-f0-9]{64}$/),
          content: z.string(),
          mediaType: z.string(),
          path: z.string(),
          sizeBytes: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    version: z.string(),
  })
  .strict();

// ===== Router =====

export const agentSkillsRouter = router({
  // ===== Create =====

  create: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.create'))
    .input(createSkillSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.skillImporter.createUserSkill(input);
      } catch (error) {
        handleSkillImportError(error);
      }
    }),

  // ===== Delete =====

  delete: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.delete'))
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.skillModel.delete(input.id);
    }),

  // ===== Query =====

  getById: skillProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    return ctx.skillModel.findById(input.id);
  }),

  getByIdWithZipUrl: skillProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const skill = await ctx.skillModel.findById(input.id);
      if (!skill) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
      }

      if (!skill.zipFileHash) {
        return { name: skill.name, url: null };
      }

      const fileInfo = await ctx.fileModel.checkHash(skill.zipFileHash);
      if (!fileInfo.isExist || !fileInfo.url) {
        return { name: skill.name, url: null };
      }

      const fullUrl = await ctx.fileService.getFullFileUrl(fileInfo.url);
      return { name: skill.name, url: fullUrl || null };
    }),

  getByIdentifier: skillProcedure
    .input(z.object({ identifier: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.skillModel.findByIdentifier(input.identifier);
    }),

  getByName: skillProcedure.input(z.object({ name: z.string() })).query(async ({ ctx, input }) => {
    return ctx.skillModel.findByName(input.name);
  }),

  importFromGitHub: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.importFromGitHub'))
    .input(
      z.object({
        branch: z.string().optional(),
        gitUrl: z.string().url(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.skillImporter.importFromGitHub(input);
      } catch (error) {
        handleSkillImportError(error);
      }
    }),

  importFromUrl: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.importFromUrl'))
    .input(z.object({ url: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.skillImporter.importFromUrl(input);
      } catch (error) {
        handleSkillImportError(error);
      }
    }),

  importFromZip: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.importFromZip'))
    .input(z.object({ zipFileId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.skillImporter.importFromZip(input);
      } catch (error) {
        handleSkillImportError(error);
      }
    }),

  importFromMarket: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.importFromMarket'))
    .input(z.object({ identifier: z.string() }))
    .mutation(async ({ ctx, input }) => {
      try {
        // Get download URL from market service
        const downloadUrl = ctx.marketService.getSkillDownloadUrl(input.identifier);
        // Import using the download URL
        return await ctx.skillImporter.importFromUrl(
          { url: downloadUrl },
          { identifier: input.identifier, source: 'market' },
        );
      } catch (error) {
        handleSkillImportError(error);
      }
    }),

  list: skillProcedure
    .input(
      z
        .object({
          source: z.enum(['builtin', 'market', 'user']).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      if (input?.source) {
        return ctx.skillModel.listBySource(input.source);
      }

      return ctx.skillModel.findAll();
    }),

  listResources: skillResourceProcedure
    .input(z.object({ id: z.string(), includeContent: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      const skill = await ctx.skillModel.findById(input.id);
      if (!skill) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
      }

      if (!skill.resources) {
        return [];
      }

      return ctx.skillResourceService.listResources(skill.resources, input.includeContent);
    }),

  readResource: skillResourceProcedure
    .input(
      z.object({
        id: z.string(),
        path: z.string(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const skill = await ctx.skillModel.findById(input.id);
      if (!skill) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });
      }

      if (!skill.resources || Object.keys(skill.resources).length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Skill has no resources' });
      }

      try {
        return await ctx.skillResourceService.readResource(skill.resources, input.path);
      } catch (error) {
        if (error instanceof SkillResourceError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }

        throw error;
      }
    }),

  /**
   * Authenticated browser/client execution projection for an explicit catalog
   * pin. It is deliberately separate from the public platform catalog and
   * legacy user-Skill reads, so flag-off/non-enforced callers retain their
   * original path with no additional policy/catalog I/O.
   */
  resolvePlatformPinned: wsCompatProcedure
    .use(serverDatabase)
    .input(platformSkillPinnedRefSchema)
    .output(platformSkillExecutionProjectionSchema)
    .query(async ({ ctx, input }) => {
      const runtimeSnapshot = await resolvePlatformSkillRuntimeSnapshot({
        agentPlugins: [{ identifier: input.skillKey, mode: 'pinned' }],
        db: ctx.serverDB,
        flags: parseEnterpriseFeatureFlags(process.env),
      });
      const selected = runtimeSnapshot?.catalog.refs.some(
        (ref) =>
          ref.skillKey === input.skillKey &&
          ref.version === input.version &&
          ref.checksum === input.checksum,
      );
      if (!selected) throw new TRPCError({ code: 'NOT_FOUND', message: 'Skill not found' });

      const skill = await new SkillCatalogReadService(ctx.serverDB, {
        builtinSkills: getBuiltinSkillDefinitions(),
      }).resolvePinnedForExecution(input);
      if (
        !skill ||
        skill.contentRef !== null ||
        skill.resources.some(
          (resource) => resource.content === undefined || resource.contentRef !== undefined,
        )
      ) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Skill is not executable' });
      }
      return {
        checksum: skill.checksum,
        content: skill.content,
        description: skill.description,
        identifier: skill.skillKey,
        name: skill.displayName,
        resources: skill.resources.map((resource) => ({
          checksum: resource.checksum,
          content: resource.content!,
          mediaType: resource.mediaType,
          path: resource.path,
          sizeBytes: resource.sizeBytes,
        })),
        version: skill.version,
      };
    }),

  search: skillProcedure.input(z.object({ query: z.string() })).query(async ({ ctx, input }) => {
    return ctx.skillModel.search(input.query);
  }),

  // ===== Update =====

  update: skillWriteProcedure
    .use(withManagedResourceGuard('agentSkills.update'))
    .input(updateSkillSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, content, manifest } = input;
      return ctx.skillModel.update(id, {
        content,
        // Sync name/description from manifest to top-level fields
        description: manifest?.description,
        manifest: manifest as SkillManifest | undefined,
        name: manifest?.name,
      });
    }),
});

export type AgentSkillsRouter = typeof agentSkillsRouter;
