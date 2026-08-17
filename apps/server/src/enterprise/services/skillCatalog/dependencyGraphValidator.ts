import type { SkillManifest, SkillValidationIssue } from '../../contracts/skillCatalog';
import { skillManifestSchema } from '../../contracts/skillCatalog';
import type { SkillCatalogValidatorOptions, SkillDependencyDefinition } from './validator';
import { issue } from './validatorIssues';

const DEFAULT_MAX_DEPENDENCY_DEPTH = 10;
const DEFAULT_MAX_DEPENDENCY_EDGES = 512;
const DEFAULT_MAX_DEPENDENCY_NODES = 256;
const DEFAULT_MAX_RESOLVER_CALLS = 256;

export const validateSkillDependencyGraph = async (
  root: {
    manifest: SkillManifest;
    skillKey: string;
    version: string;
  },
  options: SkillCatalogValidatorOptions,
  pushIssue: (item: SkillValidationIssue) => void,
) => {
  const resolver = options.resolveSkillDependency;
  const batchResolver = options.resolveSkillDependenciesBatch;
  const maxDepth = options.maxDependencyDepth ?? DEFAULT_MAX_DEPENDENCY_DEPTH;
  const maxEdges = options.maxDependencyEdges ?? DEFAULT_MAX_DEPENDENCY_EDGES;
  const maxNodes = options.maxDependencyNodes ?? DEFAULT_MAX_DEPENDENCY_NODES;
  const maxResolverCalls = options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS;
  const cache = new Map<string, SkillDependencyDefinition | undefined>();
  const expanded = new Set<string>();
  let edges = 0;
  let resolverCalls = 0;

  const graphLimit = (path: SkillValidationIssue['path']) => {
    pushIssue(
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
      pushIssue(
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
          pushIssue(
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
          pushIssue(
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
        pushIssue(
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
          pushIssue(
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
  const adjacency = new Map<string, Array<{ path: SkillValidationIssue['path']; toKey: string }>>();
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
        pushIssue(issue('dependency_cycle', path, 'Skill dependency graph has a cycle'));
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
