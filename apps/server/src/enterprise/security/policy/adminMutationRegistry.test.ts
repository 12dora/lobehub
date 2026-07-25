// @vitest-environment node
/**
 * Policy-shape and shard-integrity tests for ADMIN_MUTATION_REGISTRY.
 *
 * Live tRPC bidirectional reconciliation lives in
 * adminProcedureAuthorizationRegistry.test.ts — do not reintroduce a source AST
 * interpreter here.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  ADMIN_MUTATION_REGISTRY,
  type DangerousAdminMutationDefinition,
  type RegularAdminMutationDefinition,
} from './adminMutationRegistry';

const registryDir = fileURLToPath(new URL('./adminMutationRegistry/', import.meta.url));
const registryFile = path.join(registryDir, 'registry.ts');
const registryEntryFiles = [
  path.join(registryDir, 'entries.catalog.ts'),
  path.join(registryDir, 'entries.auditConnectors.ts'),
  path.join(registryDir, 'entries.identityAccess.ts'),
  path.join(registryDir, 'entries.platform.ts'),
];

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
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
