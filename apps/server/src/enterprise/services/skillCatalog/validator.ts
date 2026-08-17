import { validateInlineSkillResourcePaths } from '@lobechat/device-control/inlineSkillResources';

import {
  canonicalizePlatformSkillManifest,
  platformSkillVersionChecksum,
} from '@/database/models/platform';
import type { PlatformSkillResource } from '@/database/schemas/platform';

import type {
  SkillManifest,
  SkillValidationIssue,
  SkillValidationResult,
} from '../../contracts/skillCatalog';
import { skillManifestSchema, skillResourceContentChecksum } from '../../contracts/skillCatalog';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import { classifyDangerousInstructions } from './dangerousInstructions';
import { validateSkillDependencyGraph } from './dependencyGraphValidator';
import {
  compareIssues,
  hasLoneSurrogate,
  hasNonCanonicalString,
  issue,
  issueKey,
} from './validatorIssues';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_LOCALIZED_ENTRIES = 50;
const DEFAULT_MAX_ISSUES = 100;
const VALIDATOR_VERSION = 'm08-v3';

export interface SkillDependencyDefinition {
  manifest: unknown;
  skillKey: string;
  version: string;
}

export interface SkillCatalogValidationInput {
  allowBuiltinOverride: boolean;
  checksum: string;
  content: string;
  contentRef?: string | null;
  manifest: unknown;
  resources?: PlatformSkillResource[];
  skillKey: string;
  version: string;
}

export interface SkillCatalogValidatorOptions {
  /** Server capability/policy gate. Persisted intent alone never enables an override. */
  allowBuiltinOverride?: boolean;
  builtinSkillKeys?: ReadonlySet<string>;
  knownToolKeys?: ReadonlySet<string>;
  maxContentBytes?: number;
  maxDependencyDepth?: number;
  maxDependencyEdges?: number;
  maxDependencyNodes?: number;
  maxIssues?: number;
  maxLocalizedEntries?: number;
  maxManifestBytes?: number;
  maxResolverCalls?: number;
  /**
   * Optional batch resolver for one dependency frontier. When provided, wide graphs
   * resolve in O(depth) round-trips instead of O(nodes). Key format: `skillKey@version`.
   */
  resolveSkillDependenciesBatch?: (
    refs: readonly { skillKey: string; version: string }[],
  ) => Promise<Map<string, SkillDependencyDefinition | undefined>>;
  resolveSkillDependency?: (
    skillKey: string,
    version: string,
  ) => Promise<SkillDependencyDefinition | undefined>;
}

/** Deterministic pre-publication validation. Runtime Tool authorization remains a separate guard. */
export class SkillCatalogValidator {
  private readonly issues: SkillValidationIssue[] = [];
  private issueOverflow = false;

  constructor(private readonly options: SkillCatalogValidatorOptions = {}) {}

  private pushIssue = (item: SkillValidationIssue) => {
    const maxIssues = Math.max(1, this.options.maxIssues ?? DEFAULT_MAX_ISSUES);
    if (this.issues.length < maxIssues) {
      this.issues.push(item);
      return;
    }
    if (!this.issueOverflow) {
      this.issueOverflow = true;
      this.issues[maxIssues - 1] = issue(
        'dependency_graph_limit',
        ['validation'],
        'Validation issue limit was reached',
      );
    }
  };

  private validateBuiltinOverride = (input: SkillCatalogValidationInput) => {
    if (!this.options.builtinSkillKeys) {
      this.pushIssue(
        issue(
          'builtin_override_forbidden',
          ['skillKey'],
          'Builtin Skill catalog is unavailable; collision checks fail closed',
        ),
      );
      return;
    }
    const collides = this.options.builtinSkillKeys.has(input.skillKey);
    if (
      (collides && !(input.allowBuiltinOverride && this.options.allowBuiltinOverride)) ||
      (!collides && input.allowBuiltinOverride)
    ) {
      this.pushIssue(
        issue(
          'builtin_override_forbidden',
          ['allowBuiltinOverride'],
          'Builtin override requires a real collision, persisted intent, and server policy',
        ),
      );
    }
    try {
      validateInlineSkillResourcePaths((input.resources ?? []).map((resource) => resource.path));
    } catch {
      this.pushIssue(
        issue(
          'manifest_invalid',
          ['resources'],
          'Skill resource paths are unsafe or collide across target filesystems',
        ),
      );
    }
  };

  private validatePermissions = (manifest: SkillManifest) => {
    const { network, tools } = manifest.permissions;
    if (network.enabled !== network.allowedHosts.length > 0) {
      this.pushIssue(
        issue(
          'permissions_invalid',
          ['manifest', 'permissions', 'network'],
          'Network permission and allowed host declarations are inconsistent',
        ),
      );
    }

    const dependencyByKey = new Map<string, { index: number; optional: boolean }>();
    for (const [index, dependency] of manifest.toolDependencies.entries()) {
      if (dependencyByKey.has(dependency.toolKey)) {
        this.pushIssue(
          issue(
            'manifest_invalid',
            ['manifest', 'toolDependencies', index],
            'Tool dependency is declared more than once',
          ),
        );
      } else {
        dependencyByKey.set(dependency.toolKey, { index, optional: dependency.optional });
      }
    }

    const allowed = new Set<string>();
    for (const [index, toolKey] of tools.allow.entries()) {
      if (allowed.has(toolKey)) {
        this.pushIssue(
          issue(
            'permissions_invalid',
            ['manifest', 'permissions', 'tools', 'allow', index],
            'Allowed Tool is declared more than once',
          ),
        );
      }
      allowed.add(toolKey);
      if (!dependencyByKey.has(toolKey)) {
        this.pushIssue(
          issue(
            'permissions_invalid',
            ['manifest', 'permissions', 'tools', 'allow', index],
            'Allowed Tool must also be declared as a Tool dependency',
          ),
        );
      }
    }

    for (const [toolKey, dependency] of dependencyByKey) {
      const known = this.options.knownToolKeys?.has(toolKey) === true;
      if (!dependency.optional && !allowed.has(toolKey)) {
        this.pushIssue(
          issue(
            'permissions_invalid',
            ['manifest', 'toolDependencies', dependency.index],
            'Required Tool dependency must be present in the Tool allowlist',
          ),
        );
      }
      if (!known && !dependency.optional) {
        this.pushIssue(
          issue(
            'unknown_tool_dependency',
            ['manifest', 'toolDependencies', dependency.index],
            'Required Tool dependency is unavailable',
          ),
        );
      } else if (!known && dependency.optional && allowed.has(toolKey)) {
        this.pushIssue(
          issue(
            'unknown_tool_dependency',
            ['manifest', 'toolDependencies', dependency.index],
            'Optional allowed Tool dependency is currently unavailable',
            'warning',
          ),
        );
      }
    }
  };

  private validatePayloadIntegrity = (input: SkillCatalogValidationInput) => {
    const contentBytes = new TextEncoder().encode(input.content).byteLength;
    if (contentBytes > (this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES)) {
      this.pushIssue(
        issue('content_too_large', ['content'], 'Skill content exceeds the UTF-8 byte limit'),
      );
    }
    if (hasLoneSurrogate(input.content) || hasLoneSurrogate(input.manifest)) {
      this.pushIssue(
        issue('manifest_invalid', ['content'], 'Skill payload contains invalid Unicode'),
      );
    }
    if (hasNonCanonicalString(input.content)) {
      this.pushIssue(
        issue('manifest_invalid', ['content'], 'Skill content must use NFC and LF line endings'),
      );
    }
    if (hasNonCanonicalString(input.manifest)) {
      this.pushIssue(
        issue(
          'manifest_invalid',
          ['manifest'],
          'Skill manifest text must use NFC and LF line endings',
        ),
      );
    }
    if (
      hasLoneSurrogate(input.contentRef) ||
      hasLoneSurrogate(input.resources) ||
      hasNonCanonicalString(input.contentRef) ||
      hasNonCanonicalString(input.resources)
    ) {
      this.pushIssue(
        issue(
          'manifest_invalid',
          ['resources'],
          'Skill resources must contain valid canonical Unicode text',
        ),
      );
    }
    // Managed runtime only executes fully inline content (contentRef must stay null).
    // Reject every non-null value, including corrupted legacy empty-string rows.
    if (input.contentRef !== null && input.contentRef !== undefined) {
      this.pushIssue(
        issue(
          'non_inline_content',
          ['contentRef'],
          'Managed Skill runtime requires inline content; opaque contentRef is not executable',
        ),
      );
    }
    const resources = input.resources ?? [];
    for (const [index, resource] of resources.entries()) {
      if (resource.contentRef !== undefined || resource.content === undefined) {
        this.pushIssue(
          issue(
            'non_inline_content',
            ['resources', index, resource.contentRef !== undefined ? 'contentRef' : 'content'],
            'Managed Skill runtime requires inline resource content',
          ),
        );
      }
      // Independently verify size + checksum against UTF-8 content so stale metadata
      // (e.g. pre-canonicalization / forged digests) cannot pass publication.
      if (resource.content !== undefined) {
        const sizeBytes = new TextEncoder().encode(resource.content).byteLength;
        if (sizeBytes !== resource.sizeBytes) {
          this.pushIssue(
            issue(
              'manifest_invalid',
              ['resources', index, 'sizeBytes'],
              'Resource sizeBytes must match UTF-8 content bytes',
            ),
          );
        }
        const digest = skillResourceContentChecksum(resource.content);
        if (digest !== resource.checksum) {
          this.pushIssue(
            issue(
              'checksum_mismatch',
              ['resources', index, 'checksum'],
              'Resource checksum must match SHA-256 of UTF-8 content',
            ),
          );
        }
      }
    }

    if (containsEnterpriseSecretMaterial(input.content)) {
      this.pushIssue(
        issue(
          'secret_material_detected',
          ['content'],
          'Skill payload contains credential-shaped material',
        ),
      );
    }
    if (containsEnterpriseSecretMaterial(input.manifest)) {
      this.pushIssue(
        issue(
          'secret_material_detected',
          ['manifest'],
          'Skill manifest contains credential-shaped material',
        ),
      );
    }
    if (
      containsEnterpriseSecretMaterial(input.contentRef) ||
      containsEnterpriseSecretMaterial(input.resources)
    ) {
      this.pushIssue(
        issue(
          'secret_material_detected',
          ['resources'],
          'Skill resources contain credential-shaped material',
        ),
      );
    }
  };

  validate = async (input: SkillCatalogValidationInput): Promise<SkillValidationResult> => {
    const run = new SkillCatalogValidator(this.options);
    return run.validateIsolated(input);
  };

  private validateIsolated = async (
    input: SkillCatalogValidationInput,
  ): Promise<SkillValidationResult> => {
    this.issues.length = 0;
    this.issueOverflow = false;
    const parsedManifest = skillManifestSchema.safeParse(input.manifest);
    if (!parsedManifest.success) {
      for (const schemaIssue of parsedManifest.error.issues) {
        this.pushIssue(
          issue(
            'manifest_invalid',
            ['manifest', ...schemaIssue.path].slice(0, 30),
            'Skill manifest does not match the required schema',
          ),
        );
      }
    }

    this.validatePayloadIntegrity(input);

    const dangerous = classifyDangerousInstructions(input.content);
    if (dangerous.error) {
      this.pushIssue(
        issue(
          'dangerous_instruction',
          ['content'],
          'Skill content contains a high-confidence dangerous instruction',
        ),
      );
    }
    if (dangerous.warning) {
      this.pushIssue(
        issue(
          'dangerous_instruction',
          ['content'],
          'Skill content contains a heuristic instruction-risk signal',
          'warning',
        ),
      );
    }
    this.validateBuiltinOverride(input);

    if (parsedManifest.success) {
      const manifest = parsedManifest.data;
      const canonicalManifest = canonicalizePlatformSkillManifest(manifest);
      const manifestBytes = new TextEncoder().encode(JSON.stringify(canonicalManifest)).byteLength;
      if (manifestBytes > (this.options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES)) {
        this.pushIssue(
          issue('manifest_invalid', ['manifest'], 'Skill manifest exceeds the UTF-8 byte limit'),
        );
      }
      for (const field of ['localizedDescriptions', 'localizedDisplayNames'] as const) {
        if (
          Object.keys(manifest[field]).length >
          (this.options.maxLocalizedEntries ?? DEFAULT_MAX_LOCALIZED_ENTRIES)
        ) {
          this.pushIssue(
            issue(
              'manifest_invalid',
              ['manifest', field],
              'Localized text entry limit is exceeded',
            ),
          );
        }
      }
      const canonicalChecksum = platformSkillVersionChecksum({
        content: input.content,
        contentRef: input.contentRef,
        manifest,
        resources: input.resources,
      });
      if (canonicalChecksum !== input.checksum) {
        this.pushIssue(
          issue('checksum_mismatch', ['checksum'], 'Skill payload checksum does not match'),
        );
      }
      this.validatePermissions(manifest);
      await validateSkillDependencyGraph(
        {
          manifest,
          skillKey: input.skillKey,
          version: input.version,
        },
        this.options,
        this.pushIssue,
      );
    }

    const deduplicated = [...new Map(this.issues.map((item) => [issueKey(item), item])).values()]
      .sort(compareIssues)
      .slice(0, Math.max(1, this.options.maxIssues ?? DEFAULT_MAX_ISSUES));
    return { issues: deduplicated, validatedAt: new Date(), validatorVersion: VALIDATOR_VERSION };
  };
}
