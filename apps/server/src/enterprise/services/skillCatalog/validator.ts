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
import { skillManifestSchema } from '../../contracts/skillCatalog';
import { classifyDangerousInstructions } from './dangerousInstructions';
import { validateSkillDependencyGraph } from './dependencyGraphValidator';
import { validateSkillPayloadIntegrity } from './payloadIntegrity';
import { validateSkillPermissions } from './permissionsValidator';
import { compareIssues, issue, issueKey } from './validatorIssues';

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

    validateSkillPayloadIntegrity(input, this.options, this.pushIssue);

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
      await this.validateCanonicalManifest(input, parsedManifest.data);
    }

    const deduplicated = [...new Map(this.issues.map((item) => [issueKey(item), item])).values()]
      .sort(compareIssues)
      .slice(0, Math.max(1, this.options.maxIssues ?? DEFAULT_MAX_ISSUES));
    return { issues: deduplicated, validatedAt: new Date(), validatorVersion: VALIDATOR_VERSION };
  };

  private validateCanonicalManifest = async (
    input: SkillCatalogValidationInput,
    manifest: SkillManifest,
  ) => {
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
          issue('manifest_invalid', ['manifest', field], 'Localized text entry limit is exceeded'),
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
    validateSkillPermissions(manifest, this.options.knownToolKeys, this.pushIssue);
    await validateSkillDependencyGraph(
      {
        manifest,
        skillKey: input.skillKey,
        version: input.version,
      },
      this.options,
      this.pushIssue,
    );
  };
}
