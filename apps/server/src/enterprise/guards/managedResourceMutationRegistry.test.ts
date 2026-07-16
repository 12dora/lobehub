// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_DOCUMENT_SKILL_MUTATION_RISKS,
  MANAGED_RESOURCE_MUTATION_REGISTRY,
  type ManagedResourceMutationProcedure,
} from './managedResourceMutationRegistry';

const ROUTERS = [
  'agent',
  'agentDocument',
  'agentGroup',
  'agentSkills',
  'aiModel',
  'aiProvider',
  'composio',
  'connector',
  'home',
  'oauthDeviceFlow',
] as const;

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
  it('classifies and wires every mutation in all registered source routers exactly once', async () => {
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

    expect(discovered).toHaveLength(99);
    expect([...discovered].sort()).toEqual(Object.keys(MANAGED_RESOURCE_MUTATION_REGISTRY).sort());
    for (const definition of Object.values(MANAGED_RESOURCE_MUTATION_REGISTRY)) {
      expect(['deny', 'allow', 'exempt', 'input-sensitive']).toContain(definition.classification);
      expect(definition.reason.length).toBeGreaterThan(20);
    }
  });

  it('keeps an explicit service/VFS risk inventory for every guarded agentDocument Skill write', () => {
    const guardedAgentDocumentMutations = Object.entries(MANAGED_RESOURCE_MUTATION_REGISTRY)
      .filter(
        ([procedure, definition]) =>
          procedure.startsWith('agentDocument.') &&
          (definition.classification === 'deny' || definition.classification === 'input-sensitive'),
      )
      .map(([procedure]) => procedure)
      .sort();

    expect(Object.keys(AGENT_DOCUMENT_SKILL_MUTATION_RISKS).sort()).toEqual(
      guardedAgentDocumentMutations,
    );
    expect(AGENT_DOCUMENT_SKILL_MUTATION_RISKS).toMatchObject({
      'agentDocument.copyDocumentByPath': 'path-pair',
      'agentDocument.createSkillByPath': 'direct-skill',
      'agentDocument.deleteDocumentByPath': 'path',
      'agentDocument.renameDocumentByPath': 'path-pair',
      'agentDocument.writeDocumentByPath': 'path',
    });
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
      'connector.syncBuiltinTool': 'deny',
      'connector.syncPluginTools': 'deny',
      'connector.updateToolPermission': 'exempt',
      'composio.createConnection': 'input-sensitive',
      'composio.deleteConnection': 'exempt',
      'composio.removeComposioPlugin': 'deny',
      'composio.updateComposioPlugin': 'input-sensitive',
      'oauthDeviceFlow.initiateDeviceCode': 'exempt',
      'oauthDeviceFlow.pollAuthStatus': 'deny',
      'oauthDeviceFlow.revokeAuth': 'deny',
    } as const satisfies Partial<
      Record<ManagedResourceMutationProcedure, 'allow' | 'deny' | 'exempt' | 'input-sensitive'>
    >;

    for (const [procedure, classification] of Object.entries(expected)) {
      expect(
        MANAGED_RESOURCE_MUTATION_REGISTRY[procedure as ManagedResourceMutationProcedure]
          .classification,
      ).toBe(classification);
    }
  });

  it('whole-router write scan finds no unregistered model-definition write surface', async () => {
    const routerDir = path.resolve(process.cwd(), 'apps/server/src/routers/lambda');
    const files = (await readdir(routerDir, { recursive: true }))
      .filter(
        (file) =>
          file.endsWith('.ts') &&
          !file.includes('__tests__') &&
          !file.endsWith('.test.ts') &&
          !file.endsWith('.d.ts'),
      )
      .sort();
    const writePattern =
      /agentDocumentService\.(?:associate|clone|copy|create|delete|modify|remove|rename|replace|update|upsert)|agentDocumentVfsService\.(?:copy|delete|mkdir|rename|restore|write)|skillManagementService\.createSkill|agentModel\.(?:batchCreate|create|delete|duplicate|publish|setVisibility|toggle|transfer|update)|connectorModel\.(?:create|delete|update)|aiProviderModel\.(?:create|delete|toggle|update)|aiModelModel\.(?:batch|clear|create|delete|toggle|update)|skillModel\.(?:create|delete|update)/;
    const discovered = [];
    for (const file of files) {
      const source = await readFile(path.join(routerDir, file), 'utf8');
      const code = source.replaceAll(/\/\*[\S\s]*?\*\/|\/\/.*$/gm, '');
      if (writePattern.test(code)) discovered.push(file.replace(/\.ts$/, ''));
    }
    expect(discovered).toEqual([
      'agent',
      'agentDocument',
      'agentGroup',
      'agentSkills',
      'aiModel',
      'aiProvider',
      'composio',
      'connector',
      'home',
      'oauthDeviceFlow',
    ]);
  });
});
