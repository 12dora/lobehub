// @vitest-environment node
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { agentRouter } from '@/server/routers/lambda/agent';
import { agentDocumentRouter } from '@/server/routers/lambda/agentDocument';
import { agentGroupRouter } from '@/server/routers/lambda/agentGroup';
import { agentSkillsRouter } from '@/server/routers/lambda/agentSkills';
import { aiModelRouter } from '@/server/routers/lambda/aiModel';
import { aiProviderRouter } from '@/server/routers/lambda/aiProvider';
import { composioRouter } from '@/server/routers/lambda/composio';
import { connectorRouter } from '@/server/routers/lambda/connector';
import { homeRouter } from '@/server/routers/lambda/home';
import { oauthDeviceFlowRouter } from '@/server/routers/lambda/oauthDeviceFlow';

import { getManagedResourceGuardMetadata, withManagedResourceGuard } from './managedResource';
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

/** Source-file router name → live router object (agentGroup mounts as `group` on lambda). */
const LIVE_ROUTERS = {
  agent: agentRouter,
  agentDocument: agentDocumentRouter,
  agentGroup: agentGroupRouter,
  agentSkills: agentSkillsRouter,
  aiModel: aiModelRouter,
  aiProvider: aiProviderRouter,
  composio: composioRouter,
  connector: connectorRouter,
  home: homeRouter,
  oauthDeviceFlow: oauthDeviceFlowRouter,
} as const;

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

type ProcedureUnderTest = {
  _def?: {
    middlewares?: readonly unknown[];
    type?: unknown;
  };
};

const getLiveProcedure = (procedure: string): ProcedureUnderTest | undefined => {
  const [routerName, localName] = procedure.split('.') as [keyof typeof LIVE_ROUTERS, string];
  const router = LIVE_ROUTERS[routerName];
  if (!router || !localName) return undefined;
  return (router._def.procedures as Record<string, ProcedureUnderTest>)[localName];
};

describe('managed-resource legacy mutation registry', () => {
  it('classifies every mutation and attaches guard metadata exactly once on the live procedure', async () => {
    const discovered: string[] = [];

    for (const router of ROUTERS) {
      const source = await readFile(
        path.resolve(process.cwd(), `apps/server/src/routers/lambda/${router}.ts`),
        'utf8',
      );
      const mutations = extractMutationNames(router, source);
      discovered.push(...mutations);
    }

    expect(discovered).toHaveLength(Object.keys(MANAGED_RESOURCE_MUTATION_REGISTRY).length);
    expect([...discovered].sort()).toEqual(Object.keys(MANAGED_RESOURCE_MUTATION_REGISTRY).sort());

    for (const procedure of discovered as ManagedResourceMutationProcedure[]) {
      const definition = MANAGED_RESOURCE_MUTATION_REGISTRY[procedure];
      expect(['deny', 'allow', 'exempt', 'input-sensitive']).toContain(definition.classification);
      expect(definition.reason.length).toBeGreaterThan(20);

      const live = getLiveProcedure(procedure);
      expect(live, `missing live lambda procedure ${procedure}`).toBeDefined();
      const metadata = getManagedResourceGuardMetadata(live);
      expect(metadata).toEqual([{ procedure }]);
      expect(Object.isFrozen(metadata[0])).toBe(true);
    }
  });

  it('does not invent coverage from detached or comment-only guard strings', () => {
    const detachedHelper = `
      // withManagedResourceGuard('agent.updateAgentConfig')
      const unused = "withManagedResourceGuard('agent.updateAgentConfig')";
    `;
    expect(detachedHelper.includes(`withManagedResourceGuard('agent.updateAgentConfig')`)).toBe(
      true,
    );

    const bare = Object.assign(() => undefined, { _def: { middlewares: [] as unknown[] } });
    expect(getManagedResourceGuardMetadata(bare)).toEqual([]);

    const builder = withManagedResourceGuard('agent.updateAgentConfig') as {
      _middlewares: readonly unknown[];
    };
    const middlewareFn = builder._middlewares.at(-1);
    expect(typeof middlewareFn).toBe('function');
    expect(Object.keys(middlewareFn as object)).toEqual([]);
    expect(JSON.stringify({ middleware: middlewareFn })).toBe('{}');
    const carrier = Object.assign(() => undefined, { _def: { middlewares: [middlewareFn] } });
    expect(getManagedResourceGuardMetadata(carrier)).toEqual([
      { procedure: 'agent.updateAgentConfig' },
    ]);
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
