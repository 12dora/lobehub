// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { ADMIN_MUTATION_REGISTRY, ADMIN_MUTATION_ROUTER_SOURCES } from './adminMutationRegistry';

interface DiscoveredRouter {
  file: string;
  mutations: string[];
  router: string;
}

const routerDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../routers');
const registryFile = fileURLToPath(new URL('./adminMutationRegistry.ts', import.meta.url));

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
};

const containsMutationCall = (node: ts.Node): boolean => {
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'mutation'
  ) {
    return true;
  }

  return node.getChildren().some(containsMutationCall);
};

export const discoverMutationRouters = (file: string, source: string): DiscoveredRouter[] => {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const discovered: DiscoveredRouter[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'router'
    ) {
      const routerObject = node.initializer.arguments[0];
      if (routerObject && ts.isObjectLiteralExpression(routerObject)) {
        const mutations = routerObject.properties.flatMap((property) => {
          if (!ts.isPropertyAssignment(property) || !containsMutationCall(property.initializer)) {
            return [];
          }
          const name = propertyName(property.name);
          return name ? [name] : [];
        });
        if (mutations.length > 0) {
          discovered.push({ file, mutations, router: node.name.text });
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return discovered;
};

const discoverRegistryKeys = (source: string): string[] => {
  const sourceFile = ts.createSourceFile(
    registryFile,
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
      node.name.text === 'ADMIN_MUTATION_REGISTRY'
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
  if (!keys) throw new Error('ADMIN_MUTATION_REGISTRY object was not found');
  return keys;
};

const loadProductionRouterSources = async (): Promise<DiscoveredRouter[]> => {
  const adminFiles = (await readdir(path.join(routerDirectory, 'admin'), { recursive: true }))
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
    .sort()
    .map((file) => `admin/${file}`);
  const files = ['admin.ts', ...adminFiles];

  return (
    await Promise.all(
      files.map(async (file) =>
        discoverMutationRouters(file, await readFile(path.join(routerDirectory, file), 'utf8')),
      ),
    )
  ).flat();
};

describe('enterprise admin mutation policy registry', () => {
  it('reconciles every real mutation and router declaration in both directions', async () => {
    const discoveredRouters = await loadProductionRouterSources();
    const sourceKeys = ADMIN_MUTATION_ROUTER_SOURCES.map(({ file, router }) => `${file}:${router}`);
    const discoveredKeys = discoveredRouters.map(({ file, router }) => `${file}:${router}`);

    expect(new Set(sourceKeys).size).toBe(sourceKeys.length);
    expect(new Set(discoveredKeys).size).toBe(discoveredKeys.length);
    expect([...sourceKeys].sort()).toEqual([...discoveredKeys].sort());

    const procedures = ADMIN_MUTATION_ROUTER_SOURCES.flatMap(({ file, prefix, router }) => {
      const declaration = discoveredRouters.find(
        (candidate) => candidate.file === file && candidate.router === router,
      );
      expect(declaration, `${file}:${router} must exist`).toBeDefined();
      return declaration!.mutations.map((mutation) => `admin.${prefix}.${mutation}`);
    });

    expect(new Set(procedures).size).toBe(procedures.length);
    expect([...procedures].sort()).toEqual(Object.keys(ADMIN_MUTATION_REGISTRY).sort());
  });

  it('rejects duplicate registry declarations before object-key normalization', async () => {
    const declaredKeys = discoverRegistryKeys(await readFile(registryFile, 'utf8'));
    expect(new Set(declaredKeys).size).toBe(declaredKeys.length);
    expect([...declaredKeys].sort()).toEqual(Object.keys(ADMIN_MUTATION_REGISTRY).sort());
  });

  it('rejects a synthetic mutation whose router has not been mapped', () => {
    const source = `
      const existingRouter = router({ existing: base.mutation(() => true) });
      const newlyAddedRouter = router({ upstreamWrite: base.mutation(() => true) });
    `;
    expect(discoverMutationRouters('admin/synthetic.ts', source)).toEqual([
      { file: 'admin/synthetic.ts', mutations: ['existing'], router: 'existingRouter' },
      { file: 'admin/synthetic.ts', mutations: ['upstreamWrite'], router: 'newlyAddedRouter' },
    ]);
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

      if (!definition.dangerous) continue;
      expect(['critical', 'high']).toContain(definition.risk);
      expect(definition.controls.reason.status).not.toBe('not-applicable');
      expect(definition.controls.reauth.status).not.toBe('not-applicable');
      expect(definition.controls.audit.status).not.toBe('not-applicable');
      expect(definition.controls.rateLimit.status).not.toBe('not-applicable');
    }
  });

  it('contains policy metadata only and no sensitive material or remote address', () => {
    const serialized = JSON.stringify(ADMIN_MUTATION_REGISTRY);
    expect(serialized).not.toMatch(
      /(?:api[-_ ]?key|bearer|client[-_ ]?secret|credential|password|private[-_ ]?key|https?:\/\/)/i,
    );
  });
});
