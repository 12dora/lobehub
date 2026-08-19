'use client';

import {
  clampEffortLevel,
  type EffortLevel,
  findEffortControl,
  resolveDefaultThinkingLevelForModel,
} from '@lobechat/model-runtime';
import type { LobeAgentChatConfig } from '@lobechat/types';
import { Tooltip } from '@lobehub/ui';
import { Select } from '@lobehub/ui/base-ui';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

// Scoped hook: defaults to the user singleton, but resolves the published platform
// catalog under AdminProviderSettingsStoreProvider — same source `ModelSelect` reads,
// so the offered levels always match the model the picker next to it shows.
import { aiModelSelectors, useScopedAiInfraStore as useAiInfraStore } from '@/store/aiInfra';

/** Sentinel option value for "unset" — base-ui Select cannot carry `undefined` as a value. */
const UNSET = '__provider_default__';

export const EFFORT_SELECT_WIDTH = 120;

export interface EffortSelectProps {
  /**
   * Default-assistant mode: read the stored level out of an agent chatConfig using the
   * resolved control's `configKey` instead of the flat `value` prop.
   *
   * This mode has **no representable clear** — chatConfig effort fields are strict level
   * unions with no null member, and the settings merge drops `undefined` — so the picker
   * offers levels only and seeds itself with the effective default rather than showing a
   * "Default" option that could not persist.
   */
  chatConfig?: LobeAgentChatConfig;
  disabled?: boolean;
  model: string;
  /**
   * `undefined` means "unset" and is only ever emitted in systemAgent mode, whose leaves
   * persist an explicit `null` at the write site (the settings merge drops `undefined`).
   */
  onChange: (level: EffortLevel | undefined, configKey: keyof LobeAgentChatConfig) => void;
  provider: string;
  /** `null` is a stored clear and displays identically to `undefined`. */
  value?: string | null;
}

/**
 * Compact thinking-effort picker rendered beside a service-model `ModelSelect`.
 * Renders nothing when the selected model exposes no discrete effort control.
 */
const EffortSelect = memo<EffortSelectProps>(
  ({ chatConfig, disabled, model, onChange, provider, value }) => {
    const { t } = useTranslation('setting');
    const extendParams = useAiInfraStore(aiModelSelectors.modelExtendParams(model, provider));
    const control = useMemo(() => findEffortControl(extendParams), [extendParams]);

    // chatConfig mode cannot express a clear, so it must not advertise one.
    const isChatConfigMode = chatConfig !== undefined;

    const options = useMemo(
      () => [
        ...(isChatConfigMode
          ? []
          : [{ label: t('serviceModel.reasoningEffort.default'), value: UNSET }]),
        ...(control?.definition.levels ?? []).map((level) => ({ label: level, value: level })),
      ],
      [control, isChatConfigMode, t],
    );

    if (!control) return null;

    const { configKey } = control.definition;
    const stored = chatConfig ? (chatConfig[configKey] as string | undefined) : value;

    // With no "Default" option to fall back on, an unset chatConfig must display the level the
    // model would actually use. `thinkingLevel` is the one control whose default is
    // model-specific rather than the registry's static one.
    const effectiveDefault =
      control.key === 'thinkingLevel'
        ? resolveDefaultThinkingLevelForModel(model)
        : control.definition.defaultLevel;

    // Clamp defends against a model swap that no longer offers the persisted level.
    const selected = stored
      ? clampEffortLevel(control.definition, stored)
      : isChatConfigMode
        ? effectiveDefault
        : UNSET;

    return (
      // A bare 120px dropdown reading "Default" says nothing on its own; the base-ui Select
      // forwards no aria-label, so the tooltip is what actually names this control.
      <Tooltip title={t('serviceModel.reasoningEffort.label')}>
        <Select
          disabled={disabled}
          options={options}
          style={{ flex: 'none', minWidth: EFFORT_SELECT_WIDTH, width: EFFORT_SELECT_WIDTH }}
          value={selected}
          onChange={(next) =>
            onChange(next === UNSET ? undefined : (next as EffortLevel), configKey)
          }
        />
      </Tooltip>
    );
  },
);

EffortSelect.displayName = 'EffortSelect';

export default EffortSelect;
