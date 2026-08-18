import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_MODULES_ENABLED,
  computeEffectiveModules,
  DEFAULT_PLATFORM_MODULE_PRESET,
  isPlatformModuleId,
  matchPreset,
  MODULE_BY_ADMIN_ROUTER_KEY,
  MODULE_BY_ASYNC_ROUTER_KEY,
  MODULE_BY_LAMBDA_ROUTER_KEY,
  MODULE_BY_TOOLS_ROUTER_KEY,
  MODULE_BY_WORKER_NAME,
  modulesForPreset,
  parseDisabledModulesList,
  PLATFORM_MODULE_IDS,
  PLATFORM_MODULE_PRESET_ENV,
  PLATFORM_MODULE_PRESETS,
  PLATFORM_MODULES,
  PLATFORM_MODULES_DISABLED_ENV,
  resolveModulesFromEnv,
  RESTART_MODULE_IDS,
} from './modules';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '../../../..');

const extractRouterKeys = (absPath: string, exportName: string): string[] => {
  const src = readFileSync(absPath, 'utf8');
  const match = src.match(
    new RegExp(`export const ${exportName} = router\\(\\{([\\s\\S]*?)\\n\\}\\)`),
  );
  if (!match?.[1]) throw new Error(`could not find ${exportName} in ${absPath}`);
  return [...match[1].matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]!);
};

const unique = (values: string[]): string[] => [...new Set(values)];

describe('platform modules contract', () => {
  it('every PLATFORM_MODULE_IDS entry has a matching definition with the same id', () => {
    expect(Object.keys(PLATFORM_MODULES).sort()).toEqual([...PLATFORM_MODULE_IDS].sort());
    for (const id of PLATFORM_MODULE_IDS) {
      expect(PLATFORM_MODULES[id].id).toBe(id);
      expect(isPlatformModuleId(id)).toBe(true);
    }
    expect(isPlatformModuleId('not-a-module')).toBe(false);
  });

  it('lookup maps have no duplicate keys', () => {
    const pairs = [
      ['admin', (id: (typeof PLATFORM_MODULE_IDS)[number]) => PLATFORM_MODULES[id].adminRouterKeys],
      [
        'lambda',
        (id: (typeof PLATFORM_MODULE_IDS)[number]) => PLATFORM_MODULES[id].lambdaRouterKeys,
      ],
      ['async', (id: (typeof PLATFORM_MODULE_IDS)[number]) => PLATFORM_MODULES[id].asyncRouterKeys],
      ['tools', (id: (typeof PLATFORM_MODULE_IDS)[number]) => PLATFORM_MODULES[id].toolsRouterKeys],
      ['workers', (id: (typeof PLATFORM_MODULE_IDS)[number]) => PLATFORM_MODULES[id].workers],
    ] as const;

    for (const [label, pick] of pairs) {
      const keys = PLATFORM_MODULE_IDS.flatMap((id) => [...pick(id)]);
      expect(keys, `${label} keys must be unique`).toEqual(unique(keys));
    }

    expect(Object.keys(MODULE_BY_ADMIN_ROUTER_KEY)).toHaveLength(
      PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].adminRouterKeys).length,
    );
    expect(Object.keys(MODULE_BY_LAMBDA_ROUTER_KEY)).toHaveLength(
      PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].lambdaRouterKeys).length,
    );
    expect(Object.keys(MODULE_BY_ASYNC_ROUTER_KEY)).toHaveLength(
      PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].asyncRouterKeys).length,
    );
    expect(Object.keys(MODULE_BY_TOOLS_ROUTER_KEY)).toHaveLength(
      PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].toolsRouterKeys).length,
    );
    expect(Object.keys(MODULE_BY_WORKER_NAME)).toHaveLength(
      PLATFORM_MODULE_IDS.flatMap((id) => PLATFORM_MODULES[id].workers).length,
    );
  });

  it('every workers name is unique across modules', () => {
    const names = PLATFORM_MODULE_IDS.flatMap((id) => [...PLATFORM_MODULES[id].workers]);
    expect(names).toEqual(unique(names));
    for (const [name, id] of Object.entries(MODULE_BY_WORKER_NAME)) {
      expect(PLATFORM_MODULES[id].workers).toContain(name);
    }
  });

  it('listed router keys exist on the live routers', () => {
    const adminKeys = extractRouterKeys(
      path.join(repoRoot, 'apps/server/src/enterprise/routers/admin.ts'),
      'adminRouter',
    );
    const lambdaKeys = extractRouterKeys(
      path.join(repoRoot, 'apps/server/src/routers/lambda/index.ts'),
      'lambdaRouter',
    );
    const asyncKeys = extractRouterKeys(
      path.join(repoRoot, 'apps/server/src/routers/async/index.ts'),
      'asyncRouter',
    );
    const toolsKeys = extractRouterKeys(
      path.join(repoRoot, 'apps/server/src/routers/tools/index.ts'),
      'toolsRouter',
    );

    for (const key of Object.keys(MODULE_BY_ADMIN_ROUTER_KEY)) {
      expect(adminKeys, `admin.${key}`).toContain(key);
    }
    for (const key of Object.keys(MODULE_BY_LAMBDA_ROUTER_KEY)) {
      expect(lambdaKeys, `lambda.${key}`).toContain(key);
    }
    for (const key of Object.keys(MODULE_BY_ASYNC_ROUTER_KEY)) {
      expect(asyncKeys, `async.${key}`).toContain(key);
    }
    for (const key of Object.keys(MODULE_BY_TOOLS_ROUTER_KEY)) {
      expect(toolsKeys, `tools.${key}`).toContain(key);
    }
  });
});

describe('presets', () => {
  it('full is the default and enables every module', () => {
    expect(DEFAULT_PLATFORM_MODULE_PRESET).toBe('full');
    const enabled = modulesForPreset('full');
    expect(enabled.size).toBe(PLATFORM_MODULE_IDS.length);
    for (const id of PLATFORM_MODULE_IDS) expect(enabled.has(id)).toBe(true);
  });

  it('minimal / standard only enable modules at or below that tier', () => {
    const rank = { full: 2, minimal: 0, standard: 1 } as const;
    for (const preset of PLATFORM_MODULE_PRESETS) {
      const enabled = modulesForPreset(preset);
      for (const id of PLATFORM_MODULE_IDS) {
        const on = rank[PLATFORM_MODULES[id].tier] <= rank[preset];
        expect(enabled.has(id), `${preset}:${id}`).toBe(on);
      }
    }
  });

  it('matchPreset returns the exact preset or null for a custom mix', () => {
    expect(matchPreset(ALL_MODULES_ENABLED)).toBe('full');

    const standard = computeEffectiveModules(
      new Set(PLATFORM_MODULE_IDS.filter((id) => !modulesForPreset('standard').has(id))),
      null,
    );
    expect(matchPreset(standard)).toBe('standard');

    const custom = { ...ALL_MODULES_ENABLED, audit: false };
    expect(matchPreset(custom)).toBeNull();
  });
});

describe('LOBE_MODULES_DISABLED parsing', () => {
  it('accepts commas, spaces, and mixed separators; reports unknown ids', () => {
    expect(parseDisabledModulesList('audit, moderation  branding')).toEqual({
      disabled: ['audit', 'moderation', 'branding'],
      unknown: [],
    });
    expect(parseDisabledModulesList('audit,,  ,bots not-a-module')).toEqual({
      disabled: ['audit', 'bots'],
      unknown: ['not-a-module'],
    });
    expect(parseDisabledModulesList('  ')).toEqual({ disabled: [], unknown: [] });
    expect(parseDisabledModulesList(undefined)).toEqual({ disabled: [], unknown: [] });
  });

  it('treats a retired chatgptWeb env token as unknown, not a disable', () => {
    expect(isPlatformModuleId('chatgptWeb')).toBe(false);
    expect(parseDisabledModulesList('chatgptWeb')).toEqual({
      disabled: [],
      unknown: ['chatgptWeb'],
    });
  });

  it('dedupes repeated ids', () => {
    expect(parseDisabledModulesList('audit,audit audit')).toEqual({
      disabled: ['audit'],
      unknown: [],
    });
  });
});

describe('resolveModulesFromEnv', () => {
  it('defaults to full with nothing disabled', () => {
    const resolved = resolveModulesFromEnv({});
    expect(resolved.preset).toBe('full');
    expect(resolved.envDisabled.size).toBe(0);
    expect(resolved.unknownPreset).toBeNull();
  });

  it('applies LOBE_MODULE_PRESET and records the env source', () => {
    const resolved = resolveModulesFromEnv({ [PLATFORM_MODULE_PRESET_ENV]: 'minimal' });
    expect(resolved.preset).toBe('minimal');
    expect(resolved.envDisabled.has('audit')).toBe(true);
    expect(resolved.envDisabledBy.audit).toBe(`${PLATFORM_MODULE_PRESET_ENV}=minimal`);
    expect(resolved.envDisabled.has('branding')).toBe(false);
  });

  it('falls back to full on an unknown preset', () => {
    const resolved = resolveModulesFromEnv({ [PLATFORM_MODULE_PRESET_ENV]: 'tiny' });
    expect(resolved.preset).toBe('full');
    expect(resolved.unknownPreset).toBe('tiny');
  });

  it('applies LOBE_MODULES_DISABLED over the preset', () => {
    const resolved = resolveModulesFromEnv({
      [PLATFORM_MODULE_PRESET_ENV]: 'full',
      [PLATFORM_MODULES_DISABLED_ENV]: 'audit, not-real',
    });
    expect(resolved.envDisabled.has('audit')).toBe(true);
    expect(resolved.envDisabledBy.audit).toBe(PLATFORM_MODULES_DISABLED_ENV);
    expect(resolved.unknownIds).toEqual(['not-real']);
  });

  it('maps legacy ENABLE_PLATFORM_*=0 via enterprise flags', () => {
    const resolved = resolveModulesFromEnv(
      {},
      {
        ENABLE_PLATFORM_MANAGED_AGENTS: false,
        ENABLE_RUNTIME_BRANDING: false,
        ENABLE_PLATFORM_ADMIN: true,
      },
    );
    expect(resolved.envDisabled.has('managedAgents')).toBe(true);
    expect(resolved.envDisabledBy.managedAgents).toBe('ENABLE_PLATFORM_MANAGED_AGENTS');
    expect(resolved.envDisabled.has('branding')).toBe(true);
    expect(resolved.envDisabledBy.branding).toBe('ENABLE_RUNTIME_BRANDING');
    expect(resolved.envDisabled.has('audit')).toBe(false);
  });
});

describe('computeEffectiveModules', () => {
  it('missing / null db row means all on', () => {
    expect(computeEffectiveModules(new Set(), null)).toEqual(ALL_MODULES_ENABLED);
    expect(computeEffectiveModules(new Set(), undefined)).toEqual(ALL_MODULES_ENABLED);
    expect(computeEffectiveModules(new Set(), {})).toEqual(ALL_MODULES_ENABLED);
  });

  it('partial db row only turns listed modules off', () => {
    const effective = computeEffectiveModules(new Set(), { audit: false });
    expect(effective.audit).toBe(false);
    expect(effective.branding).toBe(true);
    expect(effective.moderation).toBe(true);
  });

  it('env wins over a db true', () => {
    const effective = computeEffectiveModules(new Set(['audit']), { audit: true, branding: false });
    expect(effective.audit).toBe(false);
    expect(effective.branding).toBe(false);
  });

  it('ignores a leftover chatgptWeb key from a stored DB map', () => {
    const effective = computeEffectiveModules(new Set(), {
      audit: false,
      chatgptWeb: false,
    } as Parameters<typeof computeEffectiveModules>[1]);

    expect(effective).not.toHaveProperty('chatgptWeb');
    expect(effective.audit).toBe(false);
    for (const id of PLATFORM_MODULE_IDS) {
      if (id === 'audit') continue;
      expect(effective[id]).toBe(true);
    }
    expect(matchPreset(effective)).toBeNull();
  });
});

describe('RESTART_MODULE_IDS', () => {
  it('contains exactly the kind:restart modules', () => {
    const expected = PLATFORM_MODULE_IDS.filter((id) => PLATFORM_MODULES[id].kind === 'restart');
    expect([...RESTART_MODULE_IDS].sort()).toEqual([...expected].sort());
  });
});
