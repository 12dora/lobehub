import { platformSkillVersionChecksum } from '@/database/models/platform';

import type {
  SkillManifest,
  SkillValidationIssue,
  SkillValidationResult,
} from '../../contracts/skillCatalog';
import { skillManifestSchema } from '../../contracts/skillCatalog';
import { containsSensitiveMaterial } from '../../security/redaction';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_DEPENDENCY_DEPTH = 32;
const VALIDATOR_VERSION = 'm08-v1';

const DANGEROUS_INSTRUCTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|system)\s+instructions?/i,
  /(?:reveal|print|return|exfiltrate)\s+(?:all\s+)?(?:api\s+keys?|credentials?|secrets?|tokens?)/i,
  /(?:disable|bypass)\s+(?:the\s+)?(?:tool|permission|security)\s+(?:checks?|policy|guard)/i,
] as const;

export interface SkillDependencyDefinition {
  manifest: SkillManifest;
  skillKey: string;
  version: string;
}

export interface SkillCatalogValidationInput {
  allowBuiltinOverride: boolean;
  checksum: string;
  content: string;
  manifest: unknown;
  skillKey: string;
  version: string;
}

export interface SkillCatalogValidatorOptions {
  builtinSkillKeys?: ReadonlySet<string>;
  knownToolKeys?: ReadonlySet<string>;
  maxContentBytes?: number;
  resolveSkillDependency?: (
    skillKey: string,
    version: string,
  ) => Promise<SkillDependencyDefinition | undefined>;
}

const issue = (
  code: SkillValidationIssue['code'],
  path: SkillValidationIssue['path'],
  message: string,
  severity: SkillValidationIssue['severity'] = 'error',
): SkillValidationIssue => ({ code, message, path, severity });

const issueKey = (item: SkillValidationIssue) =>
  `${item.severity}:${item.code}:${JSON.stringify(item.path)}`;

/** Deterministic pre-publication validation. Runtime Tool authorization remains a separate guard. */
export class SkillCatalogValidator {
  constructor(private readonly options: SkillCatalogValidatorOptions = {}) {}

  private validatePermissions = (manifest: SkillManifest): SkillValidationIssue[] => {
    const issues: SkillValidationIssue[] = [];
    const { network, tools } = manifest.permissions;
    if (network.enabled !== network.allowedHosts.length > 0) {
      issues.push(
        issue(
          'permissions_invalid',
          ['manifest', 'permissions', 'network'],
          'Network permission and allowed host declarations are inconsistent',
        ),
      );
    }
    const dependencyKeys = new Set(manifest.toolDependencies.map((item) => item.toolKey));
    for (const [index, toolKey] of tools.allow.entries()) {
      if (!dependencyKeys.has(toolKey)) {
        issues.push(
          issue(
            'permissions_invalid',
            ['manifest', 'permissions', 'tools', 'allow', index],
            'Allowed Tool must also be declared as a Tool dependency',
          ),
        );
      }
    }
    return issues;
  };

  private validateDependencyGraph = async (root: {
    manifest: SkillManifest;
    skillKey: string;
    version: string;
  }): Promise<SkillValidationIssue[]> => {
    const issues: SkillValidationIssue[] = [];
    const resolver = this.options.resolveSkillDependency;
    const visited = new Set<string>();

    const walk = async (
      node: { manifest: SkillManifest; skillKey: string; version: string },
      stack: string[],
      depth: number,
    ): Promise<void> => {
      const nodeKey = `${node.skillKey}@${node.version}`;
      if (depth > MAX_DEPENDENCY_DEPTH || stack.includes(nodeKey)) {
        issues.push(
          issue(
            'dependency_cycle',
            ['manifest', 'skillDependencies'],
            'Skill dependency graph contains a cycle or exceeds the maximum depth',
          ),
        );
        return;
      }
      if (visited.has(nodeKey)) return;
      visited.add(nodeKey);
      const nextStack = [...stack, nodeKey];
      for (const [index, dependency] of node.manifest.skillDependencies.entries()) {
        const dependencyKey = `${dependency.skillKey}@${dependency.version}`;
        if (nextStack.includes(dependencyKey)) {
          issues.push(
            issue(
              'dependency_cycle',
              ['manifest', 'skillDependencies', index],
              'Skill dependency graph contains a cycle',
            ),
          );
          continue;
        }
        const resolved = await resolver?.(dependency.skillKey, dependency.version);
        if (!resolved) {
          if (!dependency.optional) {
            issues.push(
              issue(
                'unknown_skill_dependency',
                ['manifest', 'skillDependencies', index],
                'Required Skill dependency is not published',
              ),
            );
          }
          continue;
        }
        await walk(resolved, nextStack, depth + 1);
      }
    };

    await walk(root, [], 0);
    return issues;
  };

  validate = async (input: SkillCatalogValidationInput): Promise<SkillValidationResult> => {
    const issues: SkillValidationIssue[] = [];
    const parsedManifest = skillManifestSchema.safeParse(input.manifest);
    if (!parsedManifest.success) {
      for (const schemaIssue of parsedManifest.error.issues.slice(0, 100)) {
        issues.push(
          issue(
            'manifest_invalid',
            ['manifest', ...schemaIssue.path],
            'Skill manifest does not match the required schema',
          ),
        );
      }
    }

    if (
      new TextEncoder().encode(input.content).byteLength >
      (this.options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES)
    ) {
      issues.push(issue('content_too_large', ['content'], 'Skill content exceeds the size limit'));
    }
    if (containsSensitiveMaterial(input.content) || containsSensitiveMaterial(input.manifest)) {
      issues.push(
        issue(
          'secret_material_detected',
          ['content'],
          'Skill payload contains secret-shaped material',
        ),
      );
    }
    if (DANGEROUS_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(input.content))) {
      issues.push(
        issue(
          'dangerous_instruction',
          ['content'],
          'Skill content contains a dangerous instruction pattern',
        ),
      );
    }
    if (this.options.builtinSkillKeys?.has(input.skillKey) && !input.allowBuiltinOverride) {
      issues.push(
        issue(
          'builtin_override_forbidden',
          ['skillKey'],
          'Builtin Skill override requires explicit approval',
        ),
      );
    }

    if (parsedManifest.success) {
      const manifest = parsedManifest.data;
      const canonicalChecksum = platformSkillVersionChecksum({ content: input.content, manifest });
      if (canonicalChecksum !== input.checksum) {
        issues.push(
          issue('checksum_mismatch', ['checksum'], 'Skill payload checksum does not match'),
        );
      }
      issues.push(...this.validatePermissions(manifest));
      const seenTools = new Set<string>();
      for (const [index, dependency] of manifest.toolDependencies.entries()) {
        if (seenTools.has(dependency.toolKey)) {
          issues.push(
            issue(
              'manifest_invalid',
              ['manifest', 'toolDependencies', index],
              'Tool dependency is declared more than once',
            ),
          );
        }
        seenTools.add(dependency.toolKey);
        if (!dependency.optional && !this.options.knownToolKeys?.has(dependency.toolKey)) {
          issues.push(
            issue(
              'unknown_tool_dependency',
              ['manifest', 'toolDependencies', index],
              'Required Tool dependency is unavailable',
            ),
          );
        }
      }
      issues.push(
        ...(await this.validateDependencyGraph({
          manifest,
          skillKey: input.skillKey,
          version: input.version,
        })),
      );
    }

    const deduplicated = [...new Map(issues.map((item) => [issueKey(item), item])).values()].sort(
      (left, right) => issueKey(left).localeCompare(issueKey(right)),
    );
    return { issues: deduplicated, validatedAt: new Date(), validatorVersion: VALIDATOR_VERSION };
  };
}
