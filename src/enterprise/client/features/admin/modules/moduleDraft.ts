import {
  matchPreset,
  modulesForPreset,
  PLATFORM_MODULE_IDS,
  PLATFORM_MODULE_PRESETS,
  PLATFORM_MODULES,
  type PlatformModuleExternalDep,
  type PlatformModuleId,
  type PlatformModulePreset,
  type PlatformModuleStateMap,
} from '@/const/platform/modules';

/**
 * Pure draft/summary maths for the 模块 page. Kept out of the components so the numbers the
 * operator makes a deployment decision on are directly testable.
 */

export interface ModuleCostSummary {
  /** Background workers / pollers owned by the enabled set (idle CPU + DB traffic). */
  backgroundJobs: number;
  /** Union of the external services the enabled set needs. */
  externalDeps: PlatformModuleExternalDep[];
  /** Sum of the measured resident-memory estimates, in MB. */
  idleRssMb: number;
  /** Enabled modules that DO carry a measurement. Zero ⇒ the memory total means nothing. */
  measured: number;
  /** Enabled modules whose `idleRssMb` has not been measured yet — the number is a floor. */
  unmeasured: number;
  /** Enabled modules that add fixed work to every message / outbound fetch. */
  workPerRequest: number;
}

/** Aggregate the constant-table costs of everything switched on in `state`. */
export const summarizeModules = (state: PlatformModuleStateMap): ModuleCostSummary => {
  const deps = new Set<PlatformModuleExternalDep>();
  let backgroundJobs = 0;
  let idleRssMb = 0;
  let measured = 0;
  let unmeasured = 0;
  let workPerRequest = 0;

  for (const id of PLATFORM_MODULE_IDS) {
    if (!state[id]) continue;
    const { cost } = PLATFORM_MODULES[id];
    backgroundJobs += cost.backgroundJobs;
    if (cost.idleRssMb === null) unmeasured += 1;
    else {
      idleRssMb += cost.idleRssMb;
      measured += 1;
    }
    if (cost.loadKind === 'perMessage' || cost.loadKind === 'perFetch') workPerRequest += 1;
    for (const dep of cost.externalDeps) deps.add(dep);
  }

  return {
    backgroundJobs,
    externalDeps: [...deps].sort(),
    idleRssMb,
    measured,
    unmeasured,
    workPerRequest,
  };
};

/** State map of a preset — the baseline the summary bar compares against. */
export const presetStateMap = (preset: PlatformModulePreset): PlatformModuleStateMap => {
  const enabled = modulesForPreset(preset);
  return Object.freeze(
    Object.fromEntries(PLATFORM_MODULE_IDS.map((id) => [id, enabled.has(id)])),
  ) as PlatformModuleStateMap;
};

export interface PresetComparison {
  /** draft − preset. Negative = the draft is lighter than the preset. */
  backgroundJobsDelta: number;
  /**
   * False when either side has unmeasured modules: subtracting two partial sums produces a
   * number that looks precise and is not. Callers must hide the memory half of the comparison.
   */
  idleRssComparable: boolean;
  idleRssMbDelta: number;
  preset: PlatformModulePreset;
}

/** Compare a draft against every preset, so the bar can say "比标准档少 N 个后台任务". */
export const comparePresets = (draft: PlatformModuleStateMap): PresetComparison[] => {
  const summary = summarizeModules(draft);
  return PLATFORM_MODULE_PRESETS.map((preset) => {
    const base = summarizeModules(presetStateMap(preset));
    return {
      backgroundJobsDelta: summary.backgroundJobs - base.backgroundJobs,
      idleRssComparable: summary.unmeasured === 0 && base.unmeasured === 0,
      idleRssMbDelta: summary.idleRssMb - base.idleRssMb,
      preset,
    };
  });
};

export interface ModuleDraftDiff {
  dirty: boolean;
  /** Modules the draft switches OFF. */
  disabled: PlatformModuleId[];
  /** Modules the draft switches ON. */
  enabled: PlatformModuleId[];
  /** Changed modules that own boot-time facilities — resources only free up after a restart. */
  restartRequired: PlatformModuleId[];
}

/** What a save would actually change, relative to the currently effective state. */
export const diffModuleDraft = (
  effective: PlatformModuleStateMap,
  draft: PlatformModuleStateMap,
): ModuleDraftDiff => {
  const enabled: PlatformModuleId[] = [];
  const disabled: PlatformModuleId[] = [];
  const restartRequired: PlatformModuleId[] = [];

  for (const id of PLATFORM_MODULE_IDS) {
    if (effective[id] === draft[id]) continue;
    if (draft[id]) enabled.push(id);
    else disabled.push(id);
    if (PLATFORM_MODULES[id].kind === 'restart') restartRequired.push(id);
  }

  return {
    dirty: enabled.length > 0 || disabled.length > 0,
    disabled,
    enabled,
    restartRequired,
  };
};

/** Only send what changed — a partial map keeps another admin's concurrent edit intact. */
export const draftToUpdatePayload = (
  effective: PlatformModuleStateMap,
  draft: PlatformModuleStateMap,
): Partial<Record<PlatformModuleId, boolean>> => {
  const payload: Partial<Record<PlatformModuleId, boolean>> = {};
  for (const id of PLATFORM_MODULE_IDS) {
    if (effective[id] !== draft[id]) payload[id] = draft[id];
  }
  return payload;
};

/**
 * Apply a preset to the draft without losing env-pinned modules: env can only disable, and the
 * console cannot undo it, so a preset never flips one of those back on.
 */
export const applyPresetToDraft = (
  preset: PlatformModulePreset,
  envDisabled: readonly PlatformModuleId[],
): PlatformModuleStateMap => {
  const enabled = modulesForPreset(preset);
  const pinned = new Set(envDisabled);
  return Object.freeze(
    Object.fromEntries(
      PLATFORM_MODULE_IDS.map((id) => [id, pinned.has(id) ? false : enabled.has(id)]),
    ),
  ) as PlatformModuleStateMap;
};

/** Preset the draft currently equals, or null = 自定义. */
export const draftPreset = (draft: PlatformModuleStateMap): PlatformModulePreset | null =>
  matchPreset(draft);

/** Toggle one module in a draft (returns a new frozen map). */
export const setModuleInDraft = (
  draft: PlatformModuleStateMap,
  id: PlatformModuleId,
  value: boolean,
): PlatformModuleStateMap => Object.freeze({ ...draft, [id]: value }) as PlatformModuleStateMap;

/** Modules a given module depends on that the draft leaves off (soft dependency warning). */
export const unmetDependencies = (
  id: PlatformModuleId,
  draft: PlatformModuleStateMap,
): PlatformModuleId[] => PLATFORM_MODULES[id].dependsOn.filter((dep) => !draft[dep]);

/** Enterprise (fork) modules first, then upstream; both keep the constant table's order. */
export const groupModuleIds = (): {
  fork: PlatformModuleId[];
  upstream: PlatformModuleId[];
} => ({
  fork: PLATFORM_MODULE_IDS.filter((id) => PLATFORM_MODULES[id].origin === 'fork'),
  upstream: PLATFORM_MODULE_IDS.filter((id) => PLATFORM_MODULES[id].origin === 'upstream'),
});
