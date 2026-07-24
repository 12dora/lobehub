// @vitest-environment node
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ADMIN_MUTATION_REGISTRY,
  type DangerousAdminMutationDefinition,
  type RegularAdminMutationDefinition,
} from './adminMutationRegistry';

interface ExpressionReference {
  file: string;
  node: ts.Expression;
}

interface MountedProperty {
  expression: ExpressionReference;
  key: string;
}

type ModuleResolver = (containingFile: string, moduleName: string) => Promise<string>;
type SourceLoader = (file: string) => Promise<string>;

const registryDir = fileURLToPath(new URL('./adminMutationRegistry/', import.meta.url));
const registryFile = path.join(registryDir, 'registry.ts');
const registryEntryFiles = [
  path.join(registryDir, 'entries.catalog.ts'),
  path.join(registryDir, 'entries.auditConnectors.ts'),
  path.join(registryDir, 'entries.identityAccess.ts'),
  path.join(registryDir, 'entries.platform.ts'),
];
// policy/adminMutationRegistry → policy → security → enterprise → apps/server/src
const serverSourceRoot = path.resolve(registryDir, '../../../..');
const repositorySourceRoot = path.resolve(serverSourceRoot, '../../../src');
const adminRouterFile = path.join(serverSourceRoot, 'enterprise/routers/admin.ts');
const lambdaRouterFile = path.join(serverSourceRoot, 'routers/lambda/index.ts');

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
};

const unwrapExpression = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isAsExpression(expression) ||
    ts.isParenthesizedExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
};

class RouterSourceGraph {
  private readonly sourceFiles = new Map<string, ts.SourceFile>();

  constructor(
    private readonly loadSource: SourceLoader,
    private readonly resolveModule: ModuleResolver,
  ) {}

  private getSourceFile = async (file: string): Promise<ts.SourceFile> => {
    const normalized = path.normalize(file);
    const existing = this.sourceFiles.get(normalized);
    if (existing) return existing;
    const sourceFile = ts.createSourceFile(
      normalized,
      await this.loadSource(normalized),
      ts.ScriptTarget.Latest,
      true,
      normalized.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    this.sourceFiles.set(normalized, sourceFile);
    return sourceFile;
  };

  private findVariable = async (
    file: string,
    name: string,
  ): Promise<ExpressionReference | null> => {
    const sourceFile = await this.getSourceFile(file);
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            return { file, node: declaration.initializer };
          }
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        const imported = statement.importClause.namedBindings.elements.find(
          (element) => element.name.text === name,
        );
        if (imported) {
          const targetFile = await this.resolveModule(file, statement.moduleSpecifier.text);
          return this.findVariable(targetFile, imported.propertyName?.text ?? imported.name.text);
        }
      }
    }
    return null;
  };

  getExport = async (file: string, name: string): Promise<ExpressionReference> => {
    const reference = await this.findVariable(file, name);
    if (!reference) throw new Error(`Variable not found: ${file}:${name}`);
    return reference;
  };

  private resolvePropertyAccess = async (
    reference: ExpressionReference,
    property: string,
  ): Promise<ExpressionReference | null> => {
    const object = await this.resolveExpression({
      file: reference.file,
      node: reference.node,
    });
    if (!ts.isObjectLiteralExpression(object.node)) return null;
    const properties = await this.expandObject(object);
    return properties.find((item) => item.key === property)?.expression ?? null;
  };

  resolveExpression = async (
    reference: ExpressionReference,
    visited: ReadonlySet<string> = new Set(),
  ): Promise<ExpressionReference> => {
    const node = unwrapExpression(reference.node);
    if (ts.isIdentifier(node)) {
      const key = `${path.normalize(reference.file)}:${node.text}`;
      if (visited.has(key)) throw new Error(`Cyclic source alias: ${key}`);
      const target = await this.findVariable(reference.file, node.text);
      if (!target) return { file: reference.file, node };
      return this.resolveExpression(target, new Set([...visited, key]));
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = await this.resolvePropertyAccess(
        { file: reference.file, node: node.expression },
        node.name.text,
      );
      if (target) return this.resolveExpression(target, visited);
    }
    return { file: reference.file, node };
  };

  private isRouterConstructor = async (
    reference: ExpressionReference,
    visited: ReadonlySet<string> = new Set(),
  ): Promise<boolean> => {
    const node = unwrapExpression(reference.node);
    if (!ts.isIdentifier(node)) return false;
    const key = `${path.normalize(reference.file)}:${node.text}`;
    if (visited.has(key)) throw new Error(`Cyclic router constructor alias: ${key}`);
    if (node.text === 'router') return true;

    const sourceFile = await this.getSourceFile(reference.file);
    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        const declaration = statement.declarationList.declarations.find(
          (item) => ts.isIdentifier(item.name) && item.name.text === node.text && item.initializer,
        );
        if (declaration?.initializer) {
          return this.isRouterConstructor(
            { file: reference.file, node: declaration.initializer },
            new Set([...visited, key]),
          );
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        statement.importClause?.namedBindings &&
        ts.isNamedImports(statement.importClause.namedBindings)
      ) {
        const imported = statement.importClause.namedBindings.elements.find(
          (element) => element.name.text === node.text,
        );
        if (imported) return (imported.propertyName?.text ?? imported.name.text) === 'router';
      }
    }
    return false;
  };

  private getObject = async (
    reference: ExpressionReference,
  ): Promise<ExpressionReference | null> => {
    const resolved = await this.resolveExpression(reference);
    if (ts.isObjectLiteralExpression(resolved.node)) return resolved;
    if (
      ts.isCallExpression(resolved.node) &&
      (await this.isRouterConstructor({ file: resolved.file, node: resolved.node.expression }))
    ) {
      const argument = resolved.node.arguments[0];
      if (argument && ts.isExpression(argument)) {
        const object = await this.resolveExpression({ file: resolved.file, node: argument });
        return ts.isObjectLiteralExpression(object.node) ? object : null;
      }
    }
    return null;
  };

  private expandObject = async (reference: ExpressionReference): Promise<MountedProperty[]> => {
    const object = await this.getObject(reference);
    if (!object || !ts.isObjectLiteralExpression(object.node)) return [];
    const properties = new Map<string, MountedProperty>();
    for (const item of object.node.properties) {
      if (ts.isSpreadAssignment(item)) {
        for (const property of await this.expandObject({
          file: object.file,
          node: item.expression,
        })) {
          properties.set(property.key, property);
        }
        continue;
      }
      if (ts.isPropertyAssignment(item)) {
        const key = propertyName(item.name);
        if (!key) throw new Error(`Computed router key is not supported: ${object.file}`);
        properties.set(key, { expression: { file: object.file, node: item.initializer }, key });
        continue;
      }
      if (ts.isShorthandPropertyAssignment(item)) {
        properties.set(item.name.text, {
          expression: { file: object.file, node: item.name },
          key: item.name.text,
        });
        continue;
      }
      throw new Error(`Unsupported router member in ${object.file}: ${item.getText()}`);
    }
    return [...properties.values()];
  };

  private isMutation = async (reference: ExpressionReference): Promise<boolean> => {
    const resolved = await this.resolveExpression(reference);
    let found = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'mutation'
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(resolved.node);
    return found;
  };

  collectMutations = async (
    reference: ExpressionReference,
    prefix: readonly string[] = [],
  ): Promise<string[]> => {
    const properties = await this.expandObject(reference);
    const paths: string[] = [];
    for (const property of properties) {
      const nested = await this.getObject(property.expression);
      if (nested) {
        paths.push(
          ...(await this.collectMutations(property.expression, [...prefix, property.key])),
        );
      } else if (await this.isMutation(property.expression)) {
        paths.push([...prefix, property.key].join('.'));
      }
    }
    return paths;
  };

  expressionIdentity = async (reference: ExpressionReference): Promise<string> => {
    const resolved = await this.resolveExpression(reference);
    return `${path.normalize(resolved.file)}:${resolved.node.pos}:${resolved.node.end}`;
  };

  rootMountsOf = async (
    root: ExpressionReference,
    target: ExpressionReference,
  ): Promise<MountedProperty[]> => {
    const targetIdentity = await this.expressionIdentity(target);
    const properties = await this.expandObject(root);
    const matches: MountedProperty[] = [];
    for (const property of properties) {
      try {
        if ((await this.expressionIdentity(property.expression)) === targetIdentity) {
          matches.push(property);
        }
      } catch {
        // Unrelated root routers can be generated business stubs outside this source checkout.
      }
    }
    return matches;
  };
}

const resolveRepositoryModule: ModuleResolver = async (containingFile, moduleName) => {
  const unresolved = moduleName.startsWith('@/server/')
    ? path.join(serverSourceRoot, moduleName.slice('@/server/'.length))
    : moduleName.startsWith('@/')
      ? path.join(repositorySourceRoot, moduleName.slice(2))
      : path.resolve(path.dirname(containingFile), moduleName);
  const candidates = [
    unresolved,
    `${unresolved}.ts`,
    `${unresolved}.tsx`,
    path.join(unresolved, 'index.ts'),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next TypeScript module shape.
    }
  }
  throw new Error(`Module not found: ${moduleName} from ${containingFile}`);
};

/** Collect procedure keys from a domain shard before they are spread into the combined registry. */
const discoverObjectKeysNamed = (
  filePath: string,
  source: string,
  exportName: string,
): string[] => {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let keys: string[] | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === exportName
    ) {
      let initializer = node.initializer;
      while (initializer && ts.isSatisfiesExpression(initializer))
        initializer = initializer.expression;
      while (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        keys = initializer.properties.flatMap((property) => {
          if (!ts.isPropertyAssignment(property)) return [];
          const name = propertyName(property.name);
          return name ? [name] : [];
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!keys) throw new Error(`${exportName} object was not found in ${filePath}`);
  return keys;
};

const discoverRegistryKeysFromShards = async (): Promise<string[]> => {
  const exportByFile: Record<string, string> = {
    'entries.catalog.ts': 'ADMIN_MUTATION_ENTRIES_CATALOG',
    'entries.auditConnectors.ts': 'ADMIN_MUTATION_ENTRIES_AUDIT_CONNECTORS',
    'entries.identityAccess.ts': 'ADMIN_MUTATION_ENTRIES_IDENTITY_ACCESS',
    'entries.platform.ts': 'ADMIN_MUTATION_ENTRIES_PLATFORM',
  };
  const keys: string[] = [];
  for (const file of registryEntryFiles) {
    const base = path.basename(file);
    const exportName = exportByFile[base];
    if (!exportName) throw new Error(`Unknown registry shard: ${base}`);
    keys.push(...discoverObjectKeysNamed(file, await readFile(file, 'utf8'), exportName));
  }
  // Combined registry must only spread shards (no inline keys) so duplicates stay detectable per shard.
  const registrySource = await readFile(registryFile, 'utf8');
  const registryAst = ts.createSourceFile(
    registryFile,
    registrySource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let sawCombined = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'ADMIN_MUTATION_REGISTRY'
    ) {
      let initializer = node.initializer;
      while (initializer && ts.isSatisfiesExpression(initializer))
        initializer = initializer.expression;
      while (initializer && ts.isAsExpression(initializer)) initializer = initializer.expression;
      if (initializer && ts.isObjectLiteralExpression(initializer)) {
        sawCombined = true;
        for (const property of initializer.properties) {
          if (!ts.isSpreadAssignment(property)) {
            throw new Error(
              'ADMIN_MUTATION_REGISTRY must only spread domain shards (no inline keys)',
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(registryAst);
  if (!sawCombined) throw new Error('ADMIN_MUTATION_REGISTRY object was not found');
  return keys;
};

describe('enterprise admin mutation policy registry', () => {
  it('reconciles the actual lambda mount and reachable admin router tree in both directions', async () => {
    const graph = new RouterSourceGraph((file) => readFile(file, 'utf8'), resolveRepositoryModule);
    const admin = await graph.getExport(adminRouterFile, 'adminRouter');
    const lambda = await graph.getExport(lambdaRouterFile, 'lambdaRouter');
    const mounts = await graph.rootMountsOf(lambda, admin);
    const procedures = (
      await Promise.all(
        mounts.map(async ({ expression, key }) =>
          (await graph.collectMutations(expression, [key])).sort(),
        ),
      )
    ).flat();

    expect(mounts.map(({ key }) => key)).toEqual(['admin']);
    expect(new Set(procedures).size).toBe(procedures.length);
    expect(procedures.sort()).toEqual(Object.keys(ADMIN_MUTATION_REGISTRY).sort());
  });

  it('follows import aliases, extracted shorthand, spreads, removals, and remounts', async () => {
    const fixtureSources = new Map([
      [
        '/fixture/leaf.ts',
        `
          const extracted = base.mutation(() => true);
          export const leafRouter = router({ extracted });
          export const removedRouter = router({});
        `,
      ],
      [
        '/fixture/root.ts',
        `
          import { leafRouter as alias, removedRouter } from './leaf';
          const spreadMount = { remounted: alias };
          export const rootRouter = router({ ...spreadMount, removedRouter });
        `,
      ],
    ]);
    const graph = new RouterSourceGraph(
      async (file) => fixtureSources.get(file) ?? Promise.reject(new Error(`Missing ${file}`)),
      async (containingFile, moduleName) =>
        `${path.resolve(path.dirname(containingFile), moduleName)}.ts`,
    );
    const root = await graph.getExport('/fixture/root.ts', 'rootRouter');

    expect(await graph.collectMutations(root)).toEqual(['remounted.extracted']);
  });

  it('recognizes imported and local router constructor aliases', async () => {
    const fixtureSources = new Map([
      ['/fixture/trpc.ts', 'export const router = (shape: unknown) => shape;'],
      [
        '/fixture/leaf.ts',
        `
          import { router as makeRouter } from './trpc';
          const localRouter = makeRouter;
          const extracted = base.mutation(() => true);
          export const leafRouter = localRouter({ extracted });
        `,
      ],
      [
        '/fixture/root.ts',
        `
          import { router } from './trpc';
          import { leafRouter } from './leaf';
          const makeRouter = router;
          export const rootRouter = makeRouter({ leaf: leafRouter });
        `,
      ],
    ]);
    const graph = new RouterSourceGraph(
      async (file) => fixtureSources.get(file) ?? Promise.reject(new Error(`Missing ${file}`)),
      async (containingFile, moduleName) =>
        `${path.resolve(path.dirname(containingFile), moduleName)}.ts`,
    );

    expect(
      await graph.collectMutations(await graph.getExport('/fixture/root.ts', 'rootRouter')),
    ).toEqual(['leaf.extracted']);
  });

  it('applies later spread and direct-property overrides before collecting mutations', async () => {
    const fixtureSources = new Map([
      [
        '/fixture/leaf.ts',
        `
          const alive = base.mutation(() => true);
          export const mutationRouter = router({ alive });
          export const emptyRouter = router({});
        `,
      ],
      [
        '/fixture/root.ts',
        `
          import { emptyRouter, mutationRouter } from './leaf';
          const first = { duplicate: mutationRouter, selected: mutationRouter };
          const second = { selected: emptyRouter };
          export const rootRouter = router({
            ...first,
            ...second,
            duplicate: emptyRouter,
            kept: mutationRouter,
          });
        `,
      ],
    ]);
    const graph = new RouterSourceGraph(
      async (file) => fixtureSources.get(file) ?? Promise.reject(new Error(`Missing ${file}`)),
      async (containingFile, moduleName) =>
        `${path.resolve(path.dirname(containingFile), moduleName)}.ts`,
    );

    expect(
      await graph.collectMutations(await graph.getExport('/fixture/root.ts', 'rootRouter')),
    ).toEqual(['kept.alive']);
  });

  it('rejects duplicate registry declarations before object-key normalization', async () => {
    const declaredKeys = await discoverRegistryKeysFromShards();
    expect(new Set(declaredKeys).size).toBe(declaredKeys.length);
    expect([...declaredKeys].sort()).toEqual(Object.keys(ADMIN_MUTATION_REGISTRY).sort());
  });

  it('enforces the minimum policy shape for dangerous mutations', () => {
    for (const [procedure, definition] of Object.entries(ADMIN_MUTATION_REGISTRY)) {
      expect(definition.procedure).toBe(procedure);
      expect(definition.summary.trim().length).toBeGreaterThan(10);
      for (const control of Object.values(definition.controls)) {
        const detail =
          'evidence' in control
            ? control.evidence
            : 'gap' in control
              ? control.gap
              : control.rationale;
        expect(detail.trim().length).toBeGreaterThan(10);
      }
      if (!definition.dangerous) {
        expect(['low', 'medium']).toContain(definition.risk);
        continue;
      }
      expect(['critical', 'high']).toContain(definition.risk);
      expect(definition.controls.reason.status).not.toBe('not-applicable');
      expect(definition.controls.reauth.status).not.toBe('not-applicable');
      expect(definition.controls.audit.status).not.toBe('not-applicable');
      expect(definition.controls.rateLimit.status).not.toBe('not-applicable');
    }
  });

  it('keeps all secret rotation mutations critical with enforced intent controls', () => {
    const entries = Object.values(ADMIN_MUTATION_REGISTRY).filter(({ procedure }) =>
      procedure.startsWith('admin.security.secretRotation.'),
    );
    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        dangerous: true,
        risk: 'critical',
        controls: {
          audit: { status: 'enforced' },
          rateLimit: { status: 'enforced' },
          reason: { status: 'enforced' },
          reauth: { status: 'enforced' },
        },
      });
    }
    expect(ADMIN_MUTATION_REGISTRY['admin.security.secretRotation.start'].controls).toMatchObject({
      lastKnownGood: { status: 'conditional' },
      outbound: { status: 'enforced' },
    });
    expect(ADMIN_MUTATION_REGISTRY['admin.security.secretRotation.retry'].controls).toMatchObject({
      lastKnownGood: { status: 'conditional' },
      outbound: { status: 'not-applicable' },
    });
    expect(ADMIN_MUTATION_REGISTRY['admin.security.secretRotation.restart'].controls).toMatchObject(
      {
        lastKnownGood: { status: 'conditional' },
        outbound: { status: 'not-applicable' },
      },
    );
    expect(ADMIN_MUTATION_REGISTRY['admin.security.secretRotation.cancel'].controls).toMatchObject({
      lastKnownGood: { status: 'not-applicable' },
      outbound: { status: 'not-applicable' },
    });
  });

  it('keeps high risks dangerous and regular risks below high at the type boundary', () => {
    expectTypeOf<DangerousAdminMutationDefinition['risk']>().toEqualTypeOf<'critical' | 'high'>();
    expectTypeOf<RegularAdminMutationDefinition['risk']>().toEqualTypeOf<'low' | 'medium'>();
  });

  it('contains policy metadata only and no sensitive material or remote address', () => {
    const serialized = JSON.stringify(ADMIN_MUTATION_REGISTRY);
    expect(serialized).not.toMatch(
      /(?:api[-_ ]?key|bearer|client[-_ ]?secret|credential|password|private[-_ ]?key|https?:\/\/)/i,
    );
  });

  it('has no remaining gap or planned controls on live admin mutations', () => {
    const residual = Object.entries(ADMIN_MUTATION_REGISTRY).flatMap(([procedure, definition]) =>
      Object.entries(definition.controls)
        .filter(([, control]) => control.status === 'gap' || control.status === 'planned')
        .map(([control, entry]) => ({
          control,
          detail: 'gap' in entry ? entry.gap : null,
          procedure,
          status: entry.status,
        })),
    );
    expect(residual).toEqual([]);
  });
});
