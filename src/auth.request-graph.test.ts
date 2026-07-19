/** @vitest-environment node */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const configPath = ts.findConfigFile(repositoryRoot, ts.sys.fileExists, 'tsconfig.json')!;
const parsedConfig = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  repositoryRoot,
);

const runtimeSpecifiers = (source: ts.SourceFile): string[] => {
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) return;
      if (ts.isExportDeclaration(node) && node.isTypeOnly) return;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) return;
        if (
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        ) {
          return;
        }
      }
      imports.push(node.moduleSpecifier.text);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return imports;
};

const collectRuntimeGraph = (entry: string) => {
  const visited = new Set<string>();
  const external = new Set<string>();
  const queue = [path.resolve(repositoryRoot, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const specifier of runtimeSpecifiers(source)) {
      if (specifier.startsWith('node:')) {
        external.add(specifier);
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, file, parsedConfig.options, ts.sys)
        .resolvedModule?.resolvedFileName;
      if (!resolved || resolved.includes(`${path.sep}node_modules${path.sep}`)) {
        external.add(specifier);
        continue;
      }
      queue.push(resolved);
    }
  }
  return { external, visited };
};

const forbiddenPath =
  /packages\/database|identityProvider\/(?:bootstrap|lkg|startupSnapshot)|better-auth\/define-config/;

describe('identity-provider request import graphs', () => {
  it.each(['src/proxy.ts', 'apps/server/src/globalConfig/getServerAuthConfig.ts'])(
    'keeps %s free of DB, filesystem, LKG, and startup-loader edges',
    (entry) => {
      const graph = collectRuntimeGraph(entry);
      expect([...graph.visited].filter((file) => forbiddenPath.test(file))).toEqual([]);
      expect(
        [...graph.external].filter(
          (specifier) =>
            specifier === 'drizzle-orm' ||
            specifier === '@lobechat/database' ||
            specifier === 'node:fs' ||
            specifier === 'node:fs/promises',
        ),
      ).toEqual([]);
    },
  );
});
