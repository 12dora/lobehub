import { describe, expect, it } from 'vitest';

import {
  ALL_MODULES_ENABLED,
  PLATFORM_MODULE_IDS,
  PLATFORM_MODULES,
  type PlatformModuleStateMap,
} from '@/const/platform/modules';

import {
  applyPresetToDraft,
  comparePresets,
  diffModuleDraft,
  draftPreset,
  draftToUpdatePayload,
  groupModuleIds,
  presetStateMap,
  setModuleInDraft,
  summarizeModules,
  unmetDependencies,
} from './moduleDraft';

const withOff = (...ids: readonly (typeof PLATFORM_MODULE_IDS)[number][]): PlatformModuleStateMap =>
  Object.freeze({
    ...ALL_MODULES_ENABLED,
    ...Object.fromEntries(ids.map((id) => [id, false])),
  }) as PlatformModuleStateMap;

describe('summarizeModules', () => {
  it('adds up only what is switched on', () => {
    const all = summarizeModules(ALL_MODULES_ENABLED);
    const withoutAudit = summarizeModules(withOff('audit'));

    expect(all.backgroundJobs - withoutAudit.backgroundJobs).toBe(
      PLATFORM_MODULES.audit.cost.backgroundJobs,
    );
  });

  it('counts per-message and per-fetch modules as load, not per-request ones', () => {
    const perMessageIds = PLATFORM_MODULE_IDS.filter(
      (id) =>
        PLATFORM_MODULES[id].cost.loadKind === 'perMessage' ||
        PLATFORM_MODULES[id].cost.loadKind === 'perFetch',
    );
    expect(summarizeModules(ALL_MODULES_ENABLED).workPerRequest).toBe(perMessageIds.length);
    expect(summarizeModules(withOff(...perMessageIds)).workPerRequest).toBe(0);
  });

  it('reports unmeasured modules instead of pretending the memory total is complete', () => {
    const unmeasuredIds = PLATFORM_MODULE_IDS.filter(
      (id) => PLATFORM_MODULES[id].cost.idleRssMb === null,
    );
    expect(summarizeModules(ALL_MODULES_ENABLED).unmeasured).toBe(unmeasuredIds.length);
  });

  it('unions external dependencies and drops them once the last owner is off', () => {
    const s3Owners = PLATFORM_MODULE_IDS.filter((id) =>
      PLATFORM_MODULES[id].cost.externalDeps.includes('s3'),
    );
    expect(summarizeModules(ALL_MODULES_ENABLED).externalDeps).toContain('s3');
    expect(summarizeModules(withOff(...s3Owners)).externalDeps).not.toContain('s3');
  });

  it('is empty when nothing is enabled', () => {
    const none = Object.freeze(
      Object.fromEntries(PLATFORM_MODULE_IDS.map((id) => [id, false])),
    ) as PlatformModuleStateMap;
    expect(summarizeModules(none)).toEqual({
      backgroundJobs: 0,
      externalDeps: [],
      idleRssMb: 0,
      measured: 0,
      unmeasured: 0,
      workPerRequest: 0,
    });
  });

  it('counts how many enabled modules actually carry a measurement', () => {
    // `measured === 0` is what lets the UI say 未测量 rather than a confident "≥ 0 MB".
    const measuredIds = PLATFORM_MODULE_IDS.filter(
      (id) => PLATFORM_MODULES[id].cost.idleRssMb !== null,
    );
    expect(summarizeModules(ALL_MODULES_ENABLED).measured).toBe(measuredIds.length);
  });
});

describe('presets', () => {
  it('full is everything on and matches the all-enabled default', () => {
    expect(presetStateMap('full')).toEqual(ALL_MODULES_ENABLED);
    expect(draftPreset(ALL_MODULES_ENABLED)).toBe('full');
  });

  it('marks a hand-edited selection as custom', () => {
    expect(draftPreset(withOff('taskTemplates'))).toBeNull();
  });

  it('never re-enables a module env pinned off, even when the preset includes it', () => {
    const draft = applyPresetToDraft('full', ['audit']);
    expect(draft.audit).toBe(false);
    expect(draft.moderation).toBe(true);
  });

  it('compares against a preset by cost, not by module count', () => {
    const standard = comparePresets(presetStateMap('standard')).find(
      (entry) => entry.preset === 'standard',
    );
    expect(standard).toMatchObject({ backgroundJobsDelta: 0, idleRssMbDelta: 0, preset: 'standard' });

    const lighter = comparePresets(presetStateMap('minimal')).find(
      (entry) => entry.preset === 'standard',
    );
    expect(lighter!.backgroundJobsDelta).toBeLessThan(0);
  });

  it('marks a memory comparison incomparable while either side has unmeasured modules', () => {
    // Subtracting two partial sums yields a number that looks precise and is not.
    const anyUnmeasured = PLATFORM_MODULE_IDS.some(
      (id) => PLATFORM_MODULES[id].cost.idleRssMb === null,
    );
    const standard = comparePresets(ALL_MODULES_ENABLED).find(
      (entry) => entry.preset === 'standard',
    )!;
    expect(standard.idleRssComparable).toBe(!anyUnmeasured);
    // The job-count half stays usable either way — it is exact.
    expect(Number.isInteger(standard.backgroundJobsDelta)).toBe(true);
  });
});

describe('diffModuleDraft', () => {
  it('is clean when the draft equals the effective state', () => {
    const diff = diffModuleDraft(ALL_MODULES_ENABLED, ALL_MODULES_ENABLED);
    expect(diff).toEqual({ dirty: false, disabled: [], enabled: [], restartRequired: [] });
  });

  it('separates switch-ons from switch-offs and flags the restart-kind ones', () => {
    const effective = withOff('moderation');
    const draft = setModuleInDraft(setModuleInDraft(effective, 'moderation', true), 'audit', false);
    const diff = diffModuleDraft(effective, draft);

    expect(diff.enabled).toEqual(['moderation']);
    expect(diff.disabled).toEqual(['audit']);
    // both are boot-time facilities in the constant table
    expect(diff.restartRequired).toEqual(expect.arrayContaining(['audit', 'moderation']));
    expect(diff.dirty).toBe(true);
  });

  it('does not list a hot module as needing a restart', () => {
    const hotId = PLATFORM_MODULE_IDS.find((id) => PLATFORM_MODULES[id].kind === 'hot')!;
    const diff = diffModuleDraft(ALL_MODULES_ENABLED, withOff(hotId));
    expect(diff.restartRequired).toEqual([]);
  });
});

describe('draftToUpdatePayload', () => {
  it('sends only what changed so a concurrent edit elsewhere survives', () => {
    expect(draftToUpdatePayload(ALL_MODULES_ENABLED, withOff('audit'))).toEqual({ audit: false });
  });

  it('is empty for an unchanged draft', () => {
    expect(draftToUpdatePayload(ALL_MODULES_ENABLED, ALL_MODULES_ENABLED)).toEqual({});
  });
});

describe('dependencies and grouping', () => {
  it('reports a dependency the draft leaves off', () => {
    const dependent = PLATFORM_MODULE_IDS.find((id) => PLATFORM_MODULES[id].dependsOn.length > 0)!;
    const dependency = PLATFORM_MODULES[dependent].dependsOn[0];

    expect(unmetDependencies(dependent, ALL_MODULES_ENABLED)).toEqual([]);
    expect(unmetDependencies(dependent, withOff(dependency))).toEqual([dependency]);
  });

  it('splits every module into exactly one of the two groups', () => {
    const { fork, upstream } = groupModuleIds();
    expect([...fork, ...upstream].sort()).toEqual([...PLATFORM_MODULE_IDS].sort());
    expect(fork.filter((id) => upstream.includes(id))).toEqual([]);
  });
});
