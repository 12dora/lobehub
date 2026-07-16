// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MANAGED_RESOURCE_MUTATION_REGISTRY,
  type ManagedResourceMutationProcedure,
} from './managedResourceMutationRegistry';

const ROUTERS = ['agent', 'agentSkills', 'aiModel', 'aiProvider', 'connector'] as const;

const extractMutationNames = (router: string, source: string): string[] => {
  const routerStart = source.indexOf('Router = router({');
  const routerEnd = source.indexOf('\n});', routerStart);
  if (routerStart < 0 || routerEnd < 0) throw new Error(`Router object not found: ${router}`);
  const body = source.slice(routerStart, routerEnd);
  const properties = [...body.matchAll(/^ {2}([A-Z]\w*):/gim)];

  return properties.flatMap((match, index) => {
    const segment = body.slice(match.index, properties[index + 1]?.index ?? body.length);
    return segment.includes('.mutation(') ? [`${router}.${match[1]}`] : [];
  });
};

describe('managed-resource legacy mutation registry', () => {
  it('classifies and wires every mutation in all five source routers exactly once', async () => {
    const discovered: string[] = [];

    for (const router of ROUTERS) {
      const source = await readFile(
        path.resolve(process.cwd(), `apps/server/src/routers/lambda/${router}.ts`),
        'utf8',
      );
      const mutations = extractMutationNames(router, source);
      discovered.push(...mutations);
      for (const procedure of mutations) {
        expect(
          source.includes(`withManagedResourceGuard('${procedure}')`) ||
            source.includes(`withManagedResourceGuard('${procedure}',`),
        ).toBe(true);
      }
    }

    expect(discovered).toHaveLength(51);
    expect([...discovered].sort()).toEqual(Object.keys(MANAGED_RESOURCE_MUTATION_REGISTRY).sort());
    for (const definition of Object.values(MANAGED_RESOURCE_MUTATION_REGISTRY)) {
      expect(['deny', 'allow', 'exempt']).toContain(definition.classification);
      expect(definition.reason.length).toBeGreaterThan(20);
    }
  });

  it('negative control detects an upstream mutation that has no classification', () => {
    const synthetic = `
export const aiProviderRouter = router({
  upstreamAddedMutation: aiProviderProcedure.mutation(async () => true),
});`;
    const discovered = extractMutationNames('aiProvider', synthetic);
    const missing = discovered.filter(
      (procedure) => !(procedure in MANAGED_RESOURCE_MUTATION_REGISTRY),
    );
    expect(missing).toEqual(['aiProvider.upstreamAddedMutation']);
  });

  it('distinguishes guarded deletion from runtime-use, OAuth and personal mutations', () => {
    const expected = {
      'agent.acquireAgentLock': 'allow',
      'agent.releaseAgentLock': 'allow',
      'agent.updateAgentPinned': 'exempt',
      'aiProvider.checkProviderConnectivity': 'allow',
      'connector.callTool': 'allow',
      'connector.delete': 'deny',
      'connector.resetPermissions': 'exempt',
      'connector.startOAuth': 'exempt',
      'connector.updateToolPermission': 'exempt',
    } as const satisfies Partial<
      Record<ManagedResourceMutationProcedure, 'allow' | 'deny' | 'exempt'>
    >;

    for (const [procedure, classification] of Object.entries(expected)) {
      expect(
        MANAGED_RESOURCE_MUTATION_REGISTRY[procedure as ManagedResourceMutationProcedure]
          .classification,
      ).toBe(classification);
    }
  });
});
