import { validateInlineSkillResourcePaths } from '@lobechat/device-control';

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
import { skillManifestSchema, skillResourceContentChecksum } from '../../contracts/skillCatalog';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_MAX_LOCALIZED_ENTRIES = 50;
const DEFAULT_MAX_DEPENDENCY_DEPTH = 10;
const DEFAULT_MAX_DEPENDENCY_EDGES = 512;
const DEFAULT_MAX_DEPENDENCY_NODES = 256;
const DEFAULT_MAX_ISSUES = 100;
const DEFAULT_MAX_RESOLVER_CALLS = 256;
const VALIDATOR_VERSION = 'm08-v3';

const HEURISTIC_INSTRUCTION_PATTERNS = [
  /\b(?:jailbreak|prompt\s+injection|system\s+prompt)\b/i,
  /(?:越狱|提示词注入|系统提示词)/,
] as const;

const QUOTED_FRAGMENT_PATTERN = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/gu;
const NEGATED_COMMAND_PATTERN =
  /\b(?:do\s+not|don't|never|must\s+not)\s+(?:please\s+)?(?:ignore|disregard|override|disable|bypass)\b/gi;
const CONJOINED_NEGATED_COMMAND_PATTERN =
  /\b(?:nor|or)\s+(?:please\s+)?(?:ignore|disregard|override|disable|bypass)\b/gi;
const NEGATED_COMMAND_ZH_PATTERN = /(?:不要|不得|禁止|请勿)\s*(?:忽略|无视|绕过|禁用)/g;
const CONJOINED_NEGATED_COMMAND_ZH_PATTERN =
  /(?:也不要|也不得|也请勿|或者|或)\s*(?:忽略|无视|绕过|禁用)/g;
const NEGATION_SCOPE_SEPARATOR_PATTERN =
  /([,:，：]|\b(?:but|however|then|yet)\b|但是|但|然而|然后)/giu;
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

const maskNegatedActionGroups = (clause: string) =>
  clause
    .split(NEGATION_SCOPE_SEPARATOR_PATTERN)
    .map((segment) => {
      const english = segment.replaceAll(NEGATED_COMMAND_PATTERN, 'safe-command');
      const englishGroup =
        english === segment
          ? english
          : english.replaceAll(CONJOINED_NEGATED_COMMAND_PATTERN, ' safe-command');
      const chinese = englishGroup.replaceAll(NEGATED_COMMAND_ZH_PATTERN, '安全提示');
      return chinese === englishGroup
        ? chinese
        : chinese.replaceAll(CONJOINED_NEGATED_COMMAND_ZH_PATTERN, '安全提示');
    })
    .join('');

const classifyDangerousInstructions = (content: string) => {
  let error = false;
  let warning = false;
  for (const rawLine of content
    .normalize('NFKC')
    .replaceAll(/\p{Cf}/gu, '')
    .replaceAll(/[‘’‛ʼꞌ]/gu, "'")
    .split(/\r?\n/)) {
    const line = rawLine.replaceAll(QUOTED_FRAGMENT_PATTERN, '').trim();
    if (!line) continue;
    for (const rawClause of line.split(CLAUSE_SEPARATOR_PATTERN)) {
      const clause = maskNegatedActionGroups(rawClause);
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

  private validateDependencyGraph = async (root: {
    manifest: SkillManifest;
    skillKey: string;
    version: string;
  }) => {
    const resolver = this.options.resolveSkillDependency;
    const batchResolver = this.options.resolveSkillDependenciesBatch;
    const maxDepth = this.options.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH;
    const maxEdges = this.options.maxDependencyEdges ?? DEFAULT_MAX_DEPENDENCY_EDGES;
    const maxNodes = this.options.maxDependencyNodes ?? DEFAULT_MAX_DEPENDENCY_NODES;
    const maxResolverCalls = this.options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS;
    const cache = new Map<string, SkillDependencyDefinition | undefined>();
    const expanded = new Set<string>();
    let edges = 0;
    let resolverCalls = 0;

    const graphLimit = (path: SkillValidationIssue['path']) => {
      this.pushIssue(
        issue('dependency_graph_limit', path, 'Skill dependency graph exceeds validation limits'),
      );
    };

    const resolveOne = async (
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

    const resolveFrontier = async (
      pending: Array<{ path: SkillValidationIssue['path']; skillKey: string; version: string }>,
    ) => {
      // De-duplicate by skillKey@version so diamond / multi-parent frontiers do not
      // double-charge resolverCalls or maxNodes for the same ref.
      const uncachedByKey = new Map<
        string,
        { path: SkillValidationIssue['path']; skillKey: string; version: string }
      >();
      for (const item of pending) {
        const key = `${item.skillKey}@${item.version}`;
        if (cache.has(key) || uncachedByKey.has(key)) continue;
        uncachedByKey.set(key, item);
      }
      const uncached = [...uncachedByKey.values()];
      if (uncached.length === 0) return;

      if (batchResolver) {
        const remainingSlots = Math.min(
          maxResolverCalls - resolverCalls,
          maxNodes - cache.size,
          uncached.length,
        );
        if (remainingSlots <= 0) {
          for (const item of uncached) graphLimit(item.path);
          return;
        }
        const batch = uncached.slice(0, remainingSlots);
        if (uncached.length > remainingSlots) {
          for (const item of uncached.slice(remainingSlots)) graphLimit(item.path);
        }
        resolverCalls += batch.length;
        try {
          const resolved = await batchResolver(
            batch.map(({ skillKey, version }) => ({ skillKey, version })),
          );
          for (const item of batch) {
            const key = `${item.skillKey}@${item.version}`;
            if (!cache.has(key)) cache.set(key, resolved.get(key));
          }
        } catch {
          for (const item of batch) {
            this.pushIssue(
              issue(
                'dependency_resolver_error',
                item.path,
                'Skill dependency resolver failed safely',
              ),
            );
            cache.set(`${item.skillKey}@${item.version}`, undefined);
          }
        }
        return;
      }

      for (const item of uncached) {
        await resolveOne(item.skillKey, item.version, item.path);
      }
    };

    type FrontierNode = {
      depth: number;
      manifest: SkillManifest;
      path: SkillValidationIssue['path'];
      skillKey: string;
      version: string;
    };

    /**
     * Directed edges of the *declared* dependency graph. Record every declared
     * edge even when the target is unresolved (publication validates a root
     * that is not yet published — `resolve(root)` returns undefined). BFS with
     * a global `expanded` set is complete for discovery/batching but incomplete
     * for cycle detection; after traversal a gray-stack DFS over this edge set
     * catches back-edges (including cycles that close on the unpublished root).
     * Unresolved targets contribute no out-edges, so they cannot invent cycles.
     */
    type DeclaredEdge = {
      fromKey: string;
      path: SkillValidationIssue['path'];
      toKey: string;
    };
    const declaredEdges: DeclaredEdge[] = [];

    let frontier: FrontierNode[] = [
      {
        depth: 0,
        manifest: root.manifest,
        path: ['manifest'],
        skillKey: root.skillKey,
        version: root.version,
      },
    ];

    while (frontier.length > 0) {
      const nextFrontier: FrontierNode[] = [];
      const pendingResolves: Array<{
        path: SkillValidationIssue['path'];
        skillKey: string;
        version: string;
      }> = [];
      const edgeWork: Array<{
        dependency: SkillManifest['skillDependencies'][number];
        dependencyPath: SkillValidationIssue['path'];
        node: FrontierNode;
        nodeKey: string;
      }> = [];

      for (const node of frontier) {
        const nodeKey = `${node.skillKey}@${node.version}`;
        if (expanded.has(nodeKey)) continue;
        if (node.depth > maxDepth) {
          graphLimit(node.path);
          continue;
        }
        expanded.add(nodeKey);

        for (const [index, dependency] of node.manifest.skillDependencies.entries()) {
          const dependencyPath = [...node.path, 'skillDependencies', index];
          edges += 1;
          if (edges > maxEdges || dependencyPath.length > 30) {
            graphLimit(dependencyPath.slice(0, 30));
            break;
          }
          edgeWork.push({ dependency, dependencyPath, node, nodeKey });
          pendingResolves.push({
            path: dependencyPath,
            skillKey: dependency.skillKey,
            version: dependency.version,
          });
        }
      }

      await resolveFrontier(pendingResolves);

      for (const { dependency, dependencyPath, node, nodeKey } of edgeWork) {
        const dependencyKey = `${dependency.skillKey}@${dependency.version}`;
        // Record the declared edge before resolve/identity/manifest guards so a
        // cycle that closes on an unpublished (unresolvable) root is still seen.
        // Mirrors pre-batch DFS: active.has(dependencyKey) ran before resolution.
        declaredEdges.push({ fromKey: nodeKey, path: dependencyPath, toKey: dependencyKey });
        const resolved = cache.get(dependencyKey);
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
        if (expanded.has(dependencyKey)) continue;
        nextFrontier.push({
          depth: node.depth + 1,
          manifest: parsed.data,
          path: [...dependencyPath, 'resolvedManifest'],
          skillKey: resolved.skillKey,
          version: resolved.version,
        });
      }

      frontier = nextFrontier;
    }

    // Exact cycle detection over the declared edge set (DFS gray-stack).
    // Deterministic: adjacency lists preserve discovery order; first back-edge wins.
    const adjacency = new Map<
      string,
      Array<{ path: SkillValidationIssue['path']; toKey: string }>
    >();
    for (const edge of declaredEdges) {
      const list = adjacency.get(edge.fromKey);
      if (list) list.push({ path: edge.path, toKey: edge.toKey });
      else adjacency.set(edge.fromKey, [{ path: edge.path, toKey: edge.toKey }]);
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const visit = (nodeKey: string): boolean => {
      color.set(nodeKey, GRAY);
      for (const { path, toKey } of adjacency.get(nodeKey) ?? []) {
        const state = color.get(toKey) ?? WHITE;
        if (state === GRAY) {
          this.pushIssue(issue('dependency_cycle', path, 'Skill dependency graph has a cycle'));
          return true;
        }
        if (state === WHITE && visit(toKey)) return true;
      }
      color.set(nodeKey, BLACK);
      return false;
    };
    const rootKey = `${root.skillKey}@${root.version}`;
    if ((color.get(rootKey) ?? WHITE) === WHITE) visit(rootKey);
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
