import type { SkillManifest, SkillValidationIssue } from '../../contracts/skillCatalog';
import { skillManifestSchema } from '../../contracts/skillCatalog';
import type { SkillCatalogValidatorOptions, SkillDependencyDefinition } from './validator';
import { issue } from './validatorIssues';

const DEFAULT_MAX_DEPENDENCY_DEPTH = 10;
const DEFAULT_MAX_DEPENDENCY_EDGES = 512;
const DEFAULT_MAX_DEPENDENCY_NODES = 256;
const DEFAULT_MAX_RESOLVER_CALLS = 256;

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

type PendingResolve = {
  path: SkillValidationIssue['path'];
  skillKey: string;
  version: string;
};

type EdgeWork = {
  dependency: SkillManifest['skillDependencies'][number];
  dependencyPath: SkillValidationIssue['path'];
  node: FrontierNode;
  nodeKey: string;
};

export class SkillDependencyGraphWalk {
  private readonly batchResolver: SkillCatalogValidatorOptions['resolveSkillDependenciesBatch'];
  private readonly cache = new Map<string, SkillDependencyDefinition | undefined>();
  private readonly declaredEdges: DeclaredEdge[] = [];
  private readonly expanded = new Set<string>();
  private readonly maxDepth: number;
  private readonly maxEdges: number;
  private readonly maxNodes: number;
  private readonly maxResolverCalls: number;
  private readonly resolver: SkillCatalogValidatorOptions['resolveSkillDependency'];
  private edges = 0;
  private frontier: FrontierNode[];
  private resolverCalls = 0;

  constructor(
    private readonly root: {
      manifest: SkillManifest;
      skillKey: string;
      version: string;
    },
    options: SkillCatalogValidatorOptions,
    private readonly pushIssue: (item: SkillValidationIssue) => void,
  ) {
    this.resolver = options.resolveSkillDependency;
    this.batchResolver = options.resolveSkillDependenciesBatch;
    this.maxDepth = options.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH;
    this.maxEdges = options.maxDependencyEdges ?? DEFAULT_MAX_DEPENDENCY_EDGES;
    this.maxNodes = options.maxDependencyNodes ?? DEFAULT_MAX_DEPENDENCY_NODES;
    this.maxResolverCalls = options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS;
    this.frontier = [
      {
        depth: 0,
        manifest: root.manifest,
        path: ['manifest'],
        skillKey: root.skillKey,
        version: root.version,
      },
    ];
  }

  validate = async () => {
    while (this.frontier.length > 0) {
      const { edgeWork, nextFrontier, pendingResolves } = this.collectFrontierWork();
      await this.resolveFrontier(pendingResolves);
      this.processResolvedEdges(edgeWork, nextFrontier);
      this.frontier = nextFrontier;
    }
    this.detectDeclaredCycles();
  };

  private graphLimit = (path: SkillValidationIssue['path']) => {
    this.pushIssue(
      issue('dependency_graph_limit', path, 'Skill dependency graph exceeds validation limits'),
    );
  };

  private resolveOne = async (
    skillKey: string,
    version: string,
    path: SkillValidationIssue['path'],
  ) => {
    const key = `${skillKey}@${version}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.cache.size >= this.maxNodes || this.resolverCalls >= this.maxResolverCalls) {
      this.graphLimit(path);
      return undefined;
    }
    this.resolverCalls += 1;
    try {
      const result = await this.resolver?.(skillKey, version);
      this.cache.set(key, result);
      return result;
    } catch {
      this.pushIssue(
        issue('dependency_resolver_error', path, 'Skill dependency resolver failed safely'),
      );
      this.cache.set(key, undefined);
      return undefined;
    }
  };

  private resolveFrontier = async (pending: PendingResolve[]) => {
    // De-duplicate by skillKey@version so diamond / multi-parent frontiers do not
    // double-charge resolverCalls or maxNodes for the same ref.
    const uncachedByKey = new Map<string, PendingResolve>();
    for (const item of pending) {
      const key = `${item.skillKey}@${item.version}`;
      if (this.cache.has(key) || uncachedByKey.has(key)) continue;
      uncachedByKey.set(key, item);
    }
    const uncached = [...uncachedByKey.values()];
    if (uncached.length === 0) return;

    if (this.batchResolver) {
      await this.resolveFrontierBatch(uncached);
      return;
    }

    for (const item of uncached) {
      await this.resolveOne(item.skillKey, item.version, item.path);
    }
  };

  private resolveFrontierBatch = async (uncached: PendingResolve[]) => {
    const remainingSlots = Math.min(
      this.maxResolverCalls - this.resolverCalls,
      this.maxNodes - this.cache.size,
      uncached.length,
    );
    if (remainingSlots <= 0) {
      for (const item of uncached) this.graphLimit(item.path);
      return;
    }
    const batch = uncached.slice(0, remainingSlots);
    if (uncached.length > remainingSlots) {
      for (const item of uncached.slice(remainingSlots)) this.graphLimit(item.path);
    }
    this.resolverCalls += batch.length;
    try {
      const resolved = await this.batchResolver!(
        batch.map(({ skillKey, version }) => ({ skillKey, version })),
      );
      for (const item of batch) {
        const key = `${item.skillKey}@${item.version}`;
        if (!this.cache.has(key)) this.cache.set(key, resolved.get(key));
      }
    } catch {
      for (const item of batch) {
        this.pushIssue(
          issue('dependency_resolver_error', item.path, 'Skill dependency resolver failed safely'),
        );
        this.cache.set(`${item.skillKey}@${item.version}`, undefined);
      }
    }
  };

  private collectFrontierWork = () => {
    const nextFrontier: FrontierNode[] = [];
    const pendingResolves: PendingResolve[] = [];
    const edgeWork: EdgeWork[] = [];

    for (const node of this.frontier) {
      const nodeKey = `${node.skillKey}@${node.version}`;
      if (this.expanded.has(nodeKey)) continue;
      if (node.depth > this.maxDepth) {
        this.graphLimit(node.path);
        continue;
      }
      this.expanded.add(nodeKey);

      for (const [index, dependency] of node.manifest.skillDependencies.entries()) {
        const dependencyPath = [...node.path, 'skillDependencies', index];
        this.edges += 1;
        if (this.edges > this.maxEdges || dependencyPath.length > 30) {
          this.graphLimit(dependencyPath.slice(0, 30));
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

    return { edgeWork, nextFrontier, pendingResolves };
  };

  private processResolvedEdges = (edgeWork: EdgeWork[], nextFrontier: FrontierNode[]) => {
    for (const { dependency, dependencyPath, node, nodeKey } of edgeWork) {
      const dependencyKey = `${dependency.skillKey}@${dependency.version}`;
      // Record the declared edge before resolve/identity/manifest guards so a
      // cycle that closes on an unpublished (unresolvable) root is still seen.
      // Mirrors pre-batch DFS: active.has(dependencyKey) ran before resolution.
      this.declaredEdges.push({ fromKey: nodeKey, path: dependencyPath, toKey: dependencyKey });
      const resolved = this.cache.get(dependencyKey);
      if (
        !this.enqueueResolvedDependency(dependency, dependencyPath, node, resolved, nextFrontier)
      ) {
        continue;
      }
    }
  };

  private enqueueResolvedDependency = (
    dependency: SkillManifest['skillDependencies'][number],
    dependencyPath: SkillValidationIssue['path'],
    node: FrontierNode,
    resolved: SkillDependencyDefinition | undefined,
    nextFrontier: FrontierNode[],
  ): boolean => {
    const dependencyKey = `${dependency.skillKey}@${dependency.version}`;
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
      return false;
    }
    if (resolved.skillKey !== dependency.skillKey || resolved.version !== dependency.version) {
      this.pushIssue(
        issue(
          'dependency_identity_mismatch',
          dependencyPath,
          'Resolved Skill dependency identity does not match the request',
        ),
      );
      return false;
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
      return false;
    }
    if (this.expanded.has(dependencyKey)) return false;
    nextFrontier.push({
      depth: node.depth + 1,
      manifest: parsed.data,
      path: [...dependencyPath, 'resolvedManifest'],
      skillKey: resolved.skillKey,
      version: resolved.version,
    });
    return true;
  };

  private detectDeclaredCycles = () => {
    // Exact cycle detection over the declared edge set (DFS gray-stack).
    // Deterministic: adjacency lists preserve discovery order; first back-edge wins.
    const adjacency = new Map<
      string,
      Array<{ path: SkillValidationIssue['path']; toKey: string }>
    >();
    for (const edge of this.declaredEdges) {
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
    const rootKey = `${this.root.skillKey}@${this.root.version}`;
    if ((color.get(rootKey) ?? WHITE) === WHITE) visit(rootKey);
  };
}
