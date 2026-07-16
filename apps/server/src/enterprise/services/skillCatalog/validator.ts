import {
  canonicalizePlatformSkillContent,
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
import { containsEnterpriseSecretMaterial } from '../../security/redaction';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_LOCALIZED_ENTRIES = 50;
const DEFAULT_MAX_DEPENDENCY_DEPTH = 10;
const DEFAULT_MAX_DEPENDENCY_EDGES = 512;
const DEFAULT_MAX_DEPENDENCY_NODES = 256;
const DEFAULT_MAX_ISSUES = 100;
const DEFAULT_MAX_RESOLVER_CALLS = 256;
const VALIDATOR_VERSION = 'm08-v2';

const HEURISTIC_INSTRUCTION_PATTERNS = [
  /\b(?:jailbreak|prompt\s+injection|system\s+prompt)\b/i,
  /(?:越狱|提示词注入|系统提示词)/,
] as const;

const QUOTED_FRAGMENT_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/gu;
const NEGATED_COMMAND_PATTERN =
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:please\s+)?(?:ignore|disregard|override|disable|bypass)\b/gi;
const NEGATED_COMMAND_ZH_PATTERN = /(?:不要|不得|禁止)\s*(?:忽略|无视|绕过|禁用)/g;
const CLAUSE_SEPARATOR_PATTERN = /[.!?;。！？；]+/u;
const PROMPT_CONTROL_ACTION_PATTERN = /\b(?:ignore|disregard|override)\b/i;
const PROMPT_CONTROL_SOURCE_PATTERN = /\b(?:developer|previous|system)\b/i;
const PROMPT_CONTROL_OBJECT_PATTERN = /\b(?:instruction|message|prompt)s?\b/i;
const SECURITY_CONTROL_ACTION_PATTERN = /\b(?:bypass|disable)\b/i;
const SECURITY_CONTROL_SCOPE_PATTERN = /\b(?:permission|security|tool)s?\b/i;
const SECURITY_CONTROL_OBJECT_PATTERN = /\b(?:checks?|guards?|polic(?:y|ies))\b/i;
const PROMPT_CONTROL_ACTION_ZH_PATTERN = /忽略|无视/;
const PROMPT_CONTROL_SOURCE_ZH_PATTERN = /之前|开发者|系统/;
const PROMPT_CONTROL_OBJECT_ZH_PATTERN = /指令|消息|提示/;
const SECURITY_CONTROL_ACTION_ZH_PATTERN = /禁用|绕过/;
const SECURITY_CONTROL_SCOPE_ZH_PATTERN = /安全|工具|权限/;
const SECURITY_CONTROL_OBJECT_ZH_PATTERN = /检查|策略|防护/;
const LONE_SURROGATE_PATTERN =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

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

const compareCodepoint = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const compareIssues = (left: SkillValidationIssue, right: SkillValidationIssue) =>
  compareCodepoint(left.severity, right.severity) ||
  compareCodepoint(left.code, right.code) ||
  compareCodepoint(JSON.stringify(left.path), JSON.stringify(right.path));

const issueKey = (item: SkillValidationIssue) =>
  `${item.severity}:${item.code}:${JSON.stringify(item.path)}`;

const hasNonCanonicalString = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (typeof value === 'string') return canonicalizePlatformSkillContent(value) !== value;
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
    hasNonCanonicalString(item, seen),
  );
};

const hasLoneSurrogate = (value: unknown, seen = new WeakSet<object>()): boolean => {
  if (typeof value === 'string') return LONE_SURROGATE_PATTERN.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return (Array.isArray(value) ? value : Object.values(value)).some((item) =>
    hasLoneSurrogate(item, seen),
  );
};

const classifyDangerousInstructions = (content: string) => {
  let error = false;
  let warning = false;
  for (const rawLine of content
    .normalize('NFKC')
    .replaceAll(/\p{Cf}/gu, '')
    .split(/\r?\n/)) {
    const line = rawLine
      .replaceAll(QUOTED_FRAGMENT_PATTERN, '')
      .replaceAll(NEGATED_COMMAND_PATTERN, 'safe-command')
      .replaceAll(NEGATED_COMMAND_ZH_PATTERN, '安全提示')
      .trim();
    if (!line) continue;
    for (const clause of line.split(CLAUSE_SEPARATOR_PATTERN)) {
      const promptControl =
        (PROMPT_CONTROL_ACTION_PATTERN.test(clause) &&
          PROMPT_CONTROL_SOURCE_PATTERN.test(clause) &&
          PROMPT_CONTROL_OBJECT_PATTERN.test(clause)) ||
        (PROMPT_CONTROL_ACTION_ZH_PATTERN.test(clause) &&
          PROMPT_CONTROL_SOURCE_ZH_PATTERN.test(clause) &&
          PROMPT_CONTROL_OBJECT_ZH_PATTERN.test(clause));
      const securityControl =
        (SECURITY_CONTROL_ACTION_PATTERN.test(clause) &&
          SECURITY_CONTROL_SCOPE_PATTERN.test(clause) &&
          SECURITY_CONTROL_OBJECT_PATTERN.test(clause)) ||
        (SECURITY_CONTROL_ACTION_ZH_PATTERN.test(clause) &&
          SECURITY_CONTROL_SCOPE_ZH_PATTERN.test(clause) &&
          SECURITY_CONTROL_OBJECT_ZH_PATTERN.test(clause));
      if (promptControl || securityControl) error = true;
      else if (HEURISTIC_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(clause))) {
        warning = true;
      }
    }
  }
  return { error, warning };
};

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

  private validateDependencyGraph = async (root: {
    manifest: SkillManifest;
    skillKey: string;
    version: string;
  }) => {
    const resolver = this.options.resolveSkillDependency;
    const maxDepth = this.options.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH;
    const maxEdges = this.options.maxDependencyEdges ?? DEFAULT_MAX_DEPENDENCY_EDGES;
    const maxNodes = this.options.maxDependencyNodes ?? DEFAULT_MAX_DEPENDENCY_NODES;
    const maxResolverCalls = this.options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS;
    const cache = new Map<string, SkillDependencyDefinition | undefined>();
    const expanded = new Set<string>();
    const active = new Set<string>();
    let edges = 0;
    let resolverCalls = 0;

    const graphLimit = (path: SkillValidationIssue['path']) => {
      this.pushIssue(
        issue('dependency_graph_limit', path, 'Skill dependency graph exceeds validation limits'),
      );
    };

    const resolve = async (
      skillKey: string,
      version: string,
      path: SkillValidationIssue['path'],
    ) => {
      const key = `${skillKey}@${version}`;
      if (cache.has(key)) return cache.get(key);
      if (cache.size >= maxNodes || resolverCalls >= maxResolverCalls) {
        graphLimit(path);
        return undefined;
      }
      resolverCalls += 1;
      try {
        const result = await resolver?.(skillKey, version);
        cache.set(key, result);
        return result;
      } catch {
        this.pushIssue(
          issue('dependency_resolver_error', path, 'Skill dependency resolver failed safely'),
        );
        cache.set(key, undefined);
        return undefined;
      }
    };

    const walk = async (
      node: { manifest: SkillManifest; skillKey: string; version: string },
      nodePath: SkillValidationIssue['path'],
      depth: number,
    ): Promise<void> => {
      const nodeKey = `${node.skillKey}@${node.version}`;
      if (active.has(nodeKey)) {
        this.pushIssue(issue('dependency_cycle', nodePath, 'Skill dependency graph has a cycle'));
        return;
      }
      if (expanded.has(nodeKey)) return;
      if (depth > maxDepth) {
        graphLimit(nodePath);
        return;
      }
      active.add(nodeKey);
      for (const [index, dependency] of node.manifest.skillDependencies.entries()) {
        const dependencyPath = [...nodePath, 'skillDependencies', index];
        edges += 1;
        if (edges > maxEdges || dependencyPath.length > 30) {
          graphLimit(dependencyPath.slice(0, 30));
          break;
        }
        const dependencyKey = `${dependency.skillKey}@${dependency.version}`;
        if (active.has(dependencyKey)) {
          this.pushIssue(
            issue('dependency_cycle', dependencyPath, 'Skill dependency graph has a cycle'),
          );
          continue;
        }
        const resolved = await resolve(dependency.skillKey, dependency.version, dependencyPath);
        if (!resolved) {
          if (!dependency.optional) {
            this.pushIssue(
              issue(
                'unknown_skill_dependency',
                dependencyPath,
                'Required Skill dependency is not published',
              ),
            );
          }
          continue;
        }
        if (resolved.skillKey !== dependency.skillKey || resolved.version !== dependency.version) {
          this.pushIssue(
            issue(
              'dependency_identity_mismatch',
              dependencyPath,
              'Resolved Skill dependency identity does not match the request',
            ),
          );
          continue;
        }
        const parsed = skillManifestSchema.safeParse(resolved.manifest);
        if (!parsed.success) {
          for (const schemaIssue of parsed.error.issues) {
            this.pushIssue(
              issue(
                'manifest_invalid',
                [...dependencyPath, 'resolvedManifest', ...schemaIssue.path].slice(0, 30),
                'Resolved Skill dependency manifest is invalid',
              ),
            );
          }
          continue;
        }
        await walk(
          { manifest: parsed.data, skillKey: resolved.skillKey, version: resolved.version },
          [...dependencyPath, 'resolvedManifest'],
          depth + 1,
        );
      }
      active.delete(nodeKey);
      expanded.add(nodeKey);
    };

    await walk(root, ['manifest'], 0);
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
      await this.validateDependencyGraph({
        manifest,
        skillKey: input.skillKey,
        version: input.version,
      });
    }

    const deduplicated = [...new Map(this.issues.map((item) => [issueKey(item), item])).values()]
      .sort(compareIssues)
      .slice(0, Math.max(1, this.options.maxIssues ?? DEFAULT_MAX_ISSUES));
    return { issues: deduplicated, validatedAt: new Date(), validatorVersion: VALIDATOR_VERSION };
  };
}
