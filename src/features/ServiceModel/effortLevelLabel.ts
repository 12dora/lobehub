import type { EffortLevel } from '@lobechat/model-runtime';

/** Every `setting` key that names a thinking-effort level. */
export type EffortLevelLabelKey = `serviceModel.reasoningEffort.options.${EffortLevel}`;

/**
 * Locale key for a thinking-effort level label, in the `setting` namespace.
 *
 * Every surface that renders a level (the in-chat pill, `EffortSelect`, the
 * `ControlsForm` slider marks) goes through here so the same level never reads
 * as two different words. Callers outside the `setting` namespace must pass
 * `{ ns: 'setting' }`.
 *
 * Accepts a plain `string` because the slider marks are generic over their level
 * list; an unknown level simply has no key, so those call sites pass a
 * `defaultValue` and fall back to the raw level.
 */
export const effortLevelLabelKey = (level: string): EffortLevelLabelKey =>
  `serviceModel.reasoningEffort.options.${level}` as EffortLevelLabelKey;
